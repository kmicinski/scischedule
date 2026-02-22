use chrono::{Datelike, Duration, NaiveDate};
use std::collections::{HashMap, HashSet, VecDeque};
use thiserror::Error;
use uuid::Uuid;

use super::{
    Deviation, Experiment, ExperimentStatus, MonthCell, MonthView, Protocol, ProtocolStep,
    ScheduledTask, TaskId, WeekDay, WeekView,
};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ScheduleError {
    #[error("protocol has duplicate step ids")]
    DuplicateStepIds,
    #[error("protocol has missing parent step")]
    MissingParent,
    #[error("protocol graph has a cycle")]
    Cycle,
    #[error("task not found")]
    TaskNotFound,
    #[error("cannot move task before its parent constraint")]
    ViolatesParentConstraint,
    #[error("cannot move task after its child constraint")]
    ViolatesChildConstraint,
}

pub fn validate_protocol(protocol: &Protocol) -> Result<(), ScheduleError> {
    let mut ids = HashSet::new();
    for step in &protocol.steps {
        if !ids.insert(step.id) {
            return Err(ScheduleError::DuplicateStepIds);
        }
    }

    for step in &protocol.steps {
        if let Some(parent) = step.parent_step_id {
            if !ids.contains(&parent) {
                return Err(ScheduleError::MissingParent);
            }
        }
    }

    let mut indegree = HashMap::<Uuid, usize>::new();
    let mut children = HashMap::<Uuid, Vec<Uuid>>::new();

    for step in &protocol.steps {
        indegree.entry(step.id).or_insert(0);
        if let Some(parent) = step.parent_step_id {
            *indegree.entry(step.id).or_insert(0) += 1;
            children.entry(parent).or_default().push(step.id);
        }
    }

    let mut queue: VecDeque<Uuid> = indegree
        .iter()
        .filter_map(|(id, degree)| if *degree == 0 { Some(*id) } else { None })
        .collect();

    let mut visited = 0;
    while let Some(curr) = queue.pop_front() {
        visited += 1;
        if let Some(kids) = children.get(&curr) {
            for child in kids {
                if let Some(degree) = indegree.get_mut(child) {
                    *degree -= 1;
                    if *degree == 0 {
                        queue.push_back(*child);
                    }
                }
            }
        }
    }

    if visited != protocol.steps.len() {
        return Err(ScheduleError::Cycle);
    }

    Ok(())
}

pub fn schedule_from_protocol(
    protocol: &Protocol,
    start_date: NaiveDate,
    created_by: String,
    now_ts: i64,
) -> Result<Experiment, ScheduleError> {
    validate_protocol(protocol)?;

    let order = topological_steps(&protocol.steps);
    let step_map: HashMap<Uuid, &ProtocolStep> = protocol.steps.iter().map(|s| (s.id, s)).collect();
    let mut computed_dates: HashMap<Uuid, NaiveDate> = HashMap::new();
    let mut tasks = Vec::with_capacity(protocol.steps.len());

    for step_id in order {
        let step = step_map[&step_id];
        let date = if let Some(parent) = step.parent_step_id {
            let parent_date = computed_dates[&parent];
            parent_date + Duration::days(step.default_offset_days as i64)
        } else {
            start_date
        };

        computed_dates.insert(step.id, date);
        tasks.push(ScheduledTask {
            id: Uuid::new_v4(),
            step_id: step.id,
            step_name: step.name.clone(),
            date,
            planned_date: date,
            day_priority: 0,
            deviation: None,
        });
    }

    normalize_day_priorities(&mut tasks);

    Ok(Experiment {
        id: Uuid::new_v4(),
        protocol_id: protocol.id,
        protocol_name: protocol.name.clone(),
        status: ExperimentStatus::Draft,
        start_date,
        tasks,
        created_by,
        created_at: now_ts,
        updated_at: now_ts,
    })
}

pub fn lock_experiment(mut experiment: Experiment, now_ts: i64) -> Experiment {
    experiment.status = ExperimentStatus::Live;
    experiment.updated_at = now_ts;
    experiment
}

pub fn move_task_with_constraints(
    experiment: &mut Experiment,
    protocol: &Protocol,
    task_id: TaskId,
    new_date: NaiveDate,
    reason: String,
    now_ts: i64,
) -> Result<(), ScheduleError> {
    let step_map: HashMap<Uuid, &ProtocolStep> = protocol.steps.iter().map(|s| (s.id, s)).collect();
    let task_map: HashMap<Uuid, &ScheduledTask> =
        experiment.tasks.iter().map(|t| (t.step_id, t)).collect();

    let idx = experiment
        .tasks
        .iter()
        .position(|t| t.id == task_id)
        .ok_or(ScheduleError::TaskNotFound)?;

    let step_id = experiment.tasks[idx].step_id;
    let step = step_map[&step_id];

    if let Some(parent_id) = step.parent_step_id {
        if let Some(parent_task) = task_map.get(&parent_id) {
            if new_date < parent_task.date {
                return Err(ScheduleError::ViolatesParentConstraint);
            }
        }
    }

    for child in protocol
        .steps
        .iter()
        .filter(|s| s.parent_step_id == Some(step_id))
    {
        if let Some(child_task) = task_map.get(&child.id) {
            if new_date > child_task.date {
                return Err(ScheduleError::ViolatesChildConstraint);
            }
        }
    }

    let old_date = experiment.tasks[idx].date;
    let shift = (new_date - experiment.tasks[idx].planned_date).num_days() as i32;
    experiment.tasks[idx].date = new_date;
    experiment.tasks[idx].deviation = if new_date != experiment.tasks[idx].planned_date {
        Some(Deviation {
            reason,
            shifted_by_days: shift,
        })
    } else {
        None
    };

    // Keep day priorities stable by re-normalizing only if this task moved days.
    if old_date != new_date {
        normalize_day_priorities(&mut experiment.tasks);
    }

    experiment.updated_at = now_ts;
    Ok(())
}

pub fn reorder_task_for_day(
    experiment: &mut Experiment,
    task_id: TaskId,
    new_priority: i32,
    now_ts: i64,
) -> Result<(), ScheduleError> {
    let idx = experiment
        .tasks
        .iter()
        .position(|t| t.id == task_id)
        .ok_or(ScheduleError::TaskNotFound)?;
    let date = experiment.tasks[idx].date;

    experiment.tasks[idx].day_priority = new_priority;

    let mut day_indices: Vec<usize> = experiment
        .tasks
        .iter()
        .enumerate()
        .filter_map(|(i, t)| if t.date == date { Some(i) } else { None })
        .collect();

    day_indices.sort_by_key(|i| experiment.tasks[*i].day_priority);

    for (ordinal, i) in day_indices.into_iter().enumerate() {
        experiment.tasks[i].day_priority = ordinal as i32;
    }

    experiment.updated_at = now_ts;
    Ok(())
}

pub fn build_month_view(experiments: &[Experiment], year: i32, month: u32) -> MonthView {
    let first = NaiveDate::from_ymd_opt(year, month, 1).expect("valid month");
    let (ny, nm) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let next = NaiveDate::from_ymd_opt(ny, nm, 1).expect("valid month");
    let span_days = (next - first).num_days();

    let mut cells: Vec<MonthCell> = (0..span_days)
        .map(|offset| MonthCell {
            date: first + Duration::days(offset),
            tasks: Vec::new(),
        })
        .collect();

    for experiment in experiments {
        for task in &experiment.tasks {
            if task.date.year() == year && task.date.month() == month {
                let idx = (task.date - first).num_days() as usize;
                cells[idx].tasks.push(task.clone());
            }
        }
    }

    for cell in &mut cells {
        cell.tasks.sort_by_key(|t| t.day_priority);
    }

    MonthView { year, month, cells }
}

pub fn build_week_view(experiments: &[Experiment], week_start: NaiveDate) -> WeekView {
    let mut days: Vec<WeekDay> = (0..7)
        .map(|offset| WeekDay {
            date: week_start + Duration::days(offset),
            tasks: Vec::new(),
        })
        .collect();

    for experiment in experiments {
        for task in &experiment.tasks {
            let offset = (task.date - week_start).num_days();
            if (0..7).contains(&offset) {
                days[offset as usize].tasks.push(task.clone());
            }
        }
    }

    for day in &mut days {
        day.tasks.sort_by_key(|t| t.day_priority);
    }

    WeekView { week_start, days }
}

fn normalize_day_priorities(tasks: &mut [ScheduledTask]) {
    let mut grouped: HashMap<NaiveDate, Vec<usize>> = HashMap::new();

    for (idx, task) in tasks.iter().enumerate() {
        grouped.entry(task.date).or_default().push(idx);
    }

    for (_, mut indices) in grouped {
        indices.sort_by_key(|i| tasks[*i].day_priority);
        for (order, idx) in indices.into_iter().enumerate() {
            tasks[idx].day_priority = order as i32;
        }
    }
}

fn topological_steps(steps: &[ProtocolStep]) -> Vec<Uuid> {
    let mut indegree = HashMap::<Uuid, usize>::new();
    let mut children = HashMap::<Uuid, Vec<Uuid>>::new();

    for step in steps {
        indegree.entry(step.id).or_insert(0);
        if let Some(parent) = step.parent_step_id {
            *indegree.entry(step.id).or_insert(0) += 1;
            children.entry(parent).or_default().push(step.id);
        }
    }

    let mut queue: VecDeque<Uuid> = indegree
        .iter()
        .filter_map(|(id, degree)| if *degree == 0 { Some(*id) } else { None })
        .collect();

    let mut order = Vec::with_capacity(steps.len());
    while let Some(curr) = queue.pop_front() {
        order.push(curr);
        if let Some(kids) = children.get(&curr) {
            for child in kids {
                let degree = indegree.get_mut(child).expect("present");
                *degree -= 1;
                if *degree == 0 {
                    queue.push_back(*child);
                }
            }
        }
    }

    order
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDate;
    use uuid::Uuid;

    use super::*;
    use crate::domain::{ExperimentStatus, Protocol};

    fn sample_protocol() -> Protocol {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let c = Uuid::new_v4();

        Protocol {
            id: Uuid::new_v4(),
            name: "PCR Workflow".to_string(),
            description: "Test protocol".to_string(),
            steps: vec![
                ProtocolStep {
                    id: a,
                    name: "Cell Seeding".to_string(),
                    details: "details".to_string(),
                    parent_step_id: None,
                    default_offset_days: 0,
                },
                ProtocolStep {
                    id: b,
                    name: "Drug Treatment".to_string(),
                    details: "details".to_string(),
                    parent_step_id: Some(a),
                    default_offset_days: 3,
                },
                ProtocolStep {
                    id: c,
                    name: "Readout".to_string(),
                    details: "details".to_string(),
                    parent_step_id: Some(b),
                    default_offset_days: 2,
                },
            ],
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn validates_good_protocol() {
        let protocol = sample_protocol();
        assert_eq!(validate_protocol(&protocol), Ok(()));
    }

    #[test]
    fn rejects_duplicate_step_ids() {
        let mut protocol = sample_protocol();
        protocol.steps[1].id = protocol.steps[0].id;
        assert_eq!(
            validate_protocol(&protocol),
            Err(ScheduleError::DuplicateStepIds)
        );
    }

    #[test]
    fn rejects_missing_parent() {
        let mut protocol = sample_protocol();
        protocol.steps[2].parent_step_id = Some(Uuid::new_v4());
        assert_eq!(
            validate_protocol(&protocol),
            Err(ScheduleError::MissingParent)
        );
    }

    #[test]
    fn rejects_cycle() {
        let mut protocol = sample_protocol();
        let first = protocol.steps[0].id;
        let third = protocol.steps[2].id;
        protocol.steps[0].parent_step_id = Some(third);
        protocol.steps[0].default_offset_days = 1;
        protocol.steps[2].parent_step_id = Some(first);

        assert_eq!(validate_protocol(&protocol), Err(ScheduleError::Cycle));
    }

    #[test]
    fn schedules_using_offsets() {
        let protocol = sample_protocol();
        let start = NaiveDate::from_ymd_opt(2026, 2, 5).unwrap();
        let experiment =
            schedule_from_protocol(&protocol, start, "alice".to_string(), 100).unwrap();

        assert_eq!(experiment.tasks.len(), 3);
        assert_eq!(
            experiment.tasks[0].date,
            NaiveDate::from_ymd_opt(2026, 2, 5).unwrap()
        );
        assert_eq!(
            experiment.tasks[1].date,
            NaiveDate::from_ymd_opt(2026, 2, 8).unwrap()
        );
        assert_eq!(
            experiment.tasks[2].date,
            NaiveDate::from_ymd_opt(2026, 2, 10).unwrap()
        );
    }

    #[test]
    fn lock_flips_status_to_live() {
        let protocol = sample_protocol();
        let start = NaiveDate::from_ymd_opt(2026, 2, 1).unwrap();
        let experiment =
            schedule_from_protocol(&protocol, start, "alice".to_string(), 100).unwrap();
        let locked = lock_experiment(experiment, 123);

        assert_eq!(locked.status, ExperimentStatus::Live);
        assert_eq!(locked.updated_at, 123);
    }

    #[test]
    fn move_task_rejects_before_parent() {
        let protocol = sample_protocol();
        let start = NaiveDate::from_ymd_opt(2026, 2, 5).unwrap();
        let mut experiment =
            schedule_from_protocol(&protocol, start, "alice".to_string(), 100).unwrap();

        let second = experiment.tasks[1].id;
        let err = move_task_with_constraints(
            &mut experiment,
            &protocol,
            second,
            NaiveDate::from_ymd_opt(2026, 2, 4).unwrap(),
            "invalid".to_string(),
            120,
        )
        .unwrap_err();

        assert_eq!(err, ScheduleError::ViolatesParentConstraint);
    }

    #[test]
    fn move_task_rejects_after_child() {
        let protocol = sample_protocol();
        let start = NaiveDate::from_ymd_opt(2026, 2, 5).unwrap();
        let mut experiment =
            schedule_from_protocol(&protocol, start, "alice".to_string(), 100).unwrap();

        let second = experiment.tasks[1].id;
        let err = move_task_with_constraints(
            &mut experiment,
            &protocol,
            second,
            NaiveDate::from_ymd_opt(2026, 2, 12).unwrap(),
            "invalid".to_string(),
            120,
        )
        .unwrap_err();

        assert_eq!(err, ScheduleError::ViolatesChildConstraint);
    }

    #[test]
    fn move_task_sets_deviation() {
        let protocol = sample_protocol();
        let start = NaiveDate::from_ymd_opt(2026, 2, 5).unwrap();
        let mut experiment =
            schedule_from_protocol(&protocol, start, "alice".to_string(), 100).unwrap();

        let second = experiment.tasks[1].id;
        move_task_with_constraints(
            &mut experiment,
            &protocol,
            second,
            NaiveDate::from_ymd_opt(2026, 2, 9).unwrap(),
            "instrument down".to_string(),
            130,
        )
        .unwrap();

        let moved = experiment.tasks.iter().find(|t| t.id == second).unwrap();
        assert_eq!(moved.date, NaiveDate::from_ymd_opt(2026, 2, 9).unwrap());
        assert!(moved.deviation.is_some());
        assert_eq!(moved.deviation.as_ref().unwrap().shifted_by_days, 1);
    }

    #[test]
    fn move_task_clears_deviation_if_back_to_plan() {
        let protocol = sample_protocol();
        let start = NaiveDate::from_ymd_opt(2026, 2, 5).unwrap();
        let mut experiment =
            schedule_from_protocol(&protocol, start, "alice".to_string(), 100).unwrap();

        let second = experiment.tasks[1].id;
        move_task_with_constraints(
            &mut experiment,
            &protocol,
            second,
            NaiveDate::from_ymd_opt(2026, 2, 9).unwrap(),
            "instrument down".to_string(),
            130,
        )
        .unwrap();

        move_task_with_constraints(
            &mut experiment,
            &protocol,
            second,
            NaiveDate::from_ymd_opt(2026, 2, 8).unwrap(),
            "restored".to_string(),
            131,
        )
        .unwrap();

        let moved = experiment.tasks.iter().find(|t| t.id == second).unwrap();
        assert!(moved.deviation.is_none());
    }

    #[test]
    fn reorder_task_reindexes_priorities() {
        let protocol = sample_protocol();
        let start = NaiveDate::from_ymd_opt(2026, 2, 5).unwrap();
        let mut experiment =
            schedule_from_protocol(&protocol, start, "alice".to_string(), 100).unwrap();

        let first = experiment.tasks[0].id;
        let second = experiment.tasks[1].id;
        let first_date = experiment.tasks[0].date;

        // put second task on same day as first for ordering test
        move_task_with_constraints(
            &mut experiment,
            &protocol,
            second,
            first_date,
            "same day".to_string(),
            111,
        )
        .unwrap();

        reorder_task_for_day(&mut experiment, second, -10, 112).unwrap();

        let day = experiment.tasks[0].date;
        let mut same_day: Vec<&ScheduledTask> =
            experiment.tasks.iter().filter(|t| t.date == day).collect();
        same_day.sort_by_key(|t| t.day_priority);

        assert_eq!(same_day[0].id, second);
        assert_eq!(same_day[0].day_priority, 0);
        assert_eq!(same_day[1].id, first);
        assert_eq!(same_day[1].day_priority, 1);
    }

    #[test]
    fn month_view_collects_tasks_in_month() {
        let protocol = sample_protocol();
        let start = NaiveDate::from_ymd_opt(2026, 2, 5).unwrap();
        let experiment =
            schedule_from_protocol(&protocol, start, "alice".to_string(), 100).unwrap();

        let month = build_month_view(&[experiment], 2026, 2);
        assert_eq!(month.cells.len(), 28);

        let feb_8 = month
            .cells
            .iter()
            .find(|c| c.date == NaiveDate::from_ymd_opt(2026, 2, 8).unwrap())
            .unwrap();
        assert_eq!(feb_8.tasks.len(), 1);
    }

    #[test]
    fn week_view_collects_only_seven_days() {
        let protocol = sample_protocol();
        let start = NaiveDate::from_ymd_opt(2026, 2, 5).unwrap();
        let experiment =
            schedule_from_protocol(&protocol, start, "alice".to_string(), 100).unwrap();

        let week = build_week_view(&[experiment], NaiveDate::from_ymd_opt(2026, 2, 2).unwrap());
        assert_eq!(week.days.len(), 7);
        assert_eq!(
            week.days[3].date,
            NaiveDate::from_ymd_opt(2026, 2, 5).unwrap()
        );
        assert_eq!(week.days[3].tasks.len(), 1);
    }

    #[test]
    fn week_view_sorts_by_day_priority() {
        let protocol = sample_protocol();
        let start = NaiveDate::from_ymd_opt(2026, 2, 5).unwrap();
        let mut experiment =
            schedule_from_protocol(&protocol, start, "alice".to_string(), 100).unwrap();

        let t0 = experiment.tasks[0].id;
        let t1 = experiment.tasks[1].id;
        let first_date = experiment.tasks[0].date;

        move_task_with_constraints(
            &mut experiment,
            &protocol,
            t1,
            first_date,
            "same day".to_string(),
            110,
        )
        .unwrap();

        reorder_task_for_day(&mut experiment, t1, -1, 111).unwrap();

        let week = build_week_view(&[experiment], NaiveDate::from_ymd_opt(2026, 2, 2).unwrap());
        let day = &week.days[3];

        assert_eq!(day.tasks[0].id, t1);
        assert_eq!(day.tasks[1].id, t0);
    }

    #[test]
    fn move_task_not_found() {
        let protocol = sample_protocol();
        let start = NaiveDate::from_ymd_opt(2026, 2, 5).unwrap();
        let mut experiment =
            schedule_from_protocol(&protocol, start, "alice".to_string(), 100).unwrap();

        let err = move_task_with_constraints(
            &mut experiment,
            &protocol,
            Uuid::new_v4(),
            NaiveDate::from_ymd_opt(2026, 2, 5).unwrap(),
            "x".to_string(),
            101,
        )
        .unwrap_err();

        assert_eq!(err, ScheduleError::TaskNotFound);
    }

    #[test]
    fn reorder_task_not_found() {
        let protocol = sample_protocol();
        let start = NaiveDate::from_ymd_opt(2026, 2, 5).unwrap();
        let mut experiment =
            schedule_from_protocol(&protocol, start, "alice".to_string(), 100).unwrap();

        let err = reorder_task_for_day(&mut experiment, Uuid::new_v4(), 1, 101).unwrap_err();
        assert_eq!(err, ScheduleError::TaskNotFound);
    }
}
