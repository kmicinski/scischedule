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
        for parent in &step.parent_step_ids {
            if !ids.contains(parent) {
                return Err(ScheduleError::MissingParent);
            }
        }
    }

    let mut indegree = HashMap::<Uuid, usize>::new();
    let mut children = HashMap::<Uuid, Vec<Uuid>>::new();

    for step in &protocol.steps {
        indegree.entry(step.id).or_insert(0);
        for parent in &step.parent_step_ids {
            *indegree.entry(step.id).or_insert(0) += 1;
            children.entry(*parent).or_default().push(step.id);
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
        let date = if step.parent_step_ids.is_empty() {
            start_date + Duration::days(step.default_offset_days as i64)
        } else {
            let latest_parent = step
                .parent_step_ids
                .iter()
                .map(|parent| computed_dates[parent])
                .max()
                .expect("validated protocol has parent dates");
            latest_parent + Duration::days(step.default_offset_days as i64)
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
            completed: false,
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
    let idx = experiment
        .tasks
        .iter()
        .position(|t| t.id == task_id)
        .ok_or(ScheduleError::TaskNotFound)?;

    let old_date = experiment.tasks[idx].date;
    if old_date == new_date {
        return Ok(());
    }
    let delta_days = (new_date - old_date).num_days();

    let mut children_by_parent = HashMap::<Uuid, Vec<Uuid>>::new();
    for step in &protocol.steps {
        for parent_id in &step.parent_step_ids {
            children_by_parent
                .entry(*parent_id)
                .or_default()
                .push(step.id);
        }
    }

    // Moving earlier: only the dragged task shifts — downstream tasks keep their
    // dates because the offset represents real duration (e.g. 3-day incubation).
    // Moving later: cascade shift to all downstream tasks to maintain constraints.
    let shifted_step_ids = if delta_days < 0 {
        let mut s = HashSet::new();
        s.insert(experiment.tasks[idx].step_id);
        s
    } else {
        descendant_step_ids(&children_by_parent, experiment.tasks[idx].step_id)
    };

    let task_date_by_step: HashMap<Uuid, NaiveDate> =
        experiment.tasks.iter().map(|t| (t.step_id, t.date)).collect();

    for step in &protocol.steps {
        let child_old = *task_date_by_step
            .get(&step.id)
            .ok_or(ScheduleError::TaskNotFound)?;
        let child_new = if shifted_step_ids.contains(&step.id) {
            child_old + Duration::days(delta_days)
        } else {
            child_old
        };

        for parent_id in &step.parent_step_ids {
            let parent_old = *task_date_by_step
                .get(parent_id)
                .ok_or(ScheduleError::TaskNotFound)?;
            let parent_new = if shifted_step_ids.contains(parent_id) {
                parent_old + Duration::days(delta_days)
            } else {
                parent_old
            };

            if child_new < parent_new {
                return Err(ScheduleError::ViolatesParentConstraint);
            }
        }
    }

    for task in &mut experiment.tasks {
        let is_shifted = shifted_step_ids.contains(&task.step_id);
        if is_shifted {
            task.date += Duration::days(delta_days);
        }
        let shifted_by_days = (task.date - task.planned_date).num_days() as i32;
        task.deviation = if task.date != task.planned_date {
            let reason = if is_shifted {
                reason.clone()
            } else {
                task.deviation
                    .as_ref()
                    .map(|d| d.reason.clone())
                    .unwrap_or_else(|| reason.clone())
            };
            Some(Deviation {
                reason,
                shifted_by_days,
            })
        } else {
            None
        };
    }

    normalize_day_priorities(&mut experiment.tasks);

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
        for parent in &step.parent_step_ids {
            *indegree.entry(step.id).or_insert(0) += 1;
            children.entry(*parent).or_default().push(step.id);
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

fn descendant_step_ids(children_by_parent: &HashMap<Uuid, Vec<Uuid>>, root: Uuid) -> HashSet<Uuid> {
    let mut out = HashSet::new();
    let mut queue = VecDeque::from([root]);

    while let Some(step_id) = queue.pop_front() {
        if !out.insert(step_id) {
            continue;
        }
        if let Some(children) = children_by_parent.get(&step_id) {
            for child_id in children {
                queue.push_back(*child_id);
            }
        }
    }

    out
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
                    parent_step_ids: vec![],
                    default_offset_days: 0,
                },
                ProtocolStep {
                    id: b,
                    name: "Drug Treatment".to_string(),
                    details: "details".to_string(),
                    parent_step_ids: vec![a],
                    default_offset_days: 3,
                },
                ProtocolStep {
                    id: c,
                    name: "Readout".to_string(),
                    details: "details".to_string(),
                    parent_step_ids: vec![b],
                    default_offset_days: 2,
                },
            ],
            created_by: String::new(),
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
        protocol.steps[2].parent_step_ids = vec![Uuid::new_v4()];
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
        protocol.steps[0].parent_step_ids = vec![third];
        protocol.steps[0].default_offset_days = 1;
        protocol.steps[2].parent_step_ids = vec![first];

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
    fn move_task_earlier_does_not_cascade_downstream() {
        // Moving earlier only shifts the dragged task — downstream tasks keep
        // their dates because the offset represents real duration.
        let protocol = sample_protocol();
        let start = NaiveDate::from_ymd_opt(2026, 2, 5).unwrap();
        let mut experiment =
            schedule_from_protocol(&protocol, start, "alice".to_string(), 100).unwrap();

        // B starts on Feb 8, C on Feb 10
        let second = experiment.tasks[1].id;
        move_task_with_constraints(
            &mut experiment,
            &protocol,
            second,
            NaiveDate::from_ymd_opt(2026, 2, 5).unwrap(),
            "shift".to_string(),
            120,
        )
        .unwrap();

        // A: unchanged at Feb 5
        assert_eq!(
            experiment.tasks[0].date,
            NaiveDate::from_ymd_opt(2026, 2, 5).unwrap()
        );
        // B: moved earlier to Feb 5
        assert_eq!(
            experiment.tasks[1].date,
            NaiveDate::from_ymd_opt(2026, 2, 5).unwrap()
        );
        // C: stays at Feb 10 (NOT shifted — the 2-day processing time is real)
        assert_eq!(
            experiment.tasks[2].date,
            NaiveDate::from_ymd_opt(2026, 2, 10).unwrap()
        );
    }

    #[test]
    fn move_task_shifts_only_downstream_forward() {
        let protocol = sample_protocol();
        let start = NaiveDate::from_ymd_opt(2026, 2, 5).unwrap();
        let mut experiment =
            schedule_from_protocol(&protocol, start, "alice".to_string(), 100).unwrap();

        let second = experiment.tasks[1].id;
        move_task_with_constraints(
            &mut experiment,
            &protocol,
            second,
            NaiveDate::from_ymd_opt(2026, 2, 12).unwrap(),
            "shift".to_string(),
            120,
        )
        .unwrap();

        assert_eq!(
            experiment.tasks[0].date,
            NaiveDate::from_ymd_opt(2026, 2, 5).unwrap()
        );
        assert_eq!(
            experiment.tasks[1].date,
            NaiveDate::from_ymd_opt(2026, 2, 12).unwrap()
        );
        assert_eq!(
            experiment.tasks[2].date,
            NaiveDate::from_ymd_opt(2026, 2, 14).unwrap()
        );
    }

    #[test]
    fn move_last_task_keeps_prior_steps_fixed() {
        let protocol = sample_protocol();
        let start = NaiveDate::from_ymd_opt(2026, 2, 5).unwrap();
        let mut experiment =
            schedule_from_protocol(&protocol, start, "alice".to_string(), 100).unwrap();

        let last = experiment.tasks[2].id;
        move_task_with_constraints(
            &mut experiment,
            &protocol,
            last,
            NaiveDate::from_ymd_opt(2026, 2, 13).unwrap(),
            "shift".to_string(),
            120,
        )
        .unwrap();

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
            NaiveDate::from_ymd_opt(2026, 2, 13).unwrap()
        );
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

        assert!(experiment.tasks[0].deviation.is_none());
        assert_eq!(experiment.tasks[1].deviation.as_ref().unwrap().shifted_by_days, 1);
        assert_eq!(experiment.tasks[2].deviation.as_ref().unwrap().shifted_by_days, 1);
    }

    #[test]
    fn move_task_before_parent_is_rejected() {
        let protocol = sample_protocol();
        let start = NaiveDate::from_ymd_opt(2026, 2, 5).unwrap();
        let mut experiment =
            schedule_from_protocol(&protocol, start, "alice".to_string(), 100).unwrap();

        let third = experiment.tasks[2].id;
        let err = move_task_with_constraints(
            &mut experiment,
            &protocol,
            third,
            NaiveDate::from_ymd_opt(2026, 2, 7).unwrap(),
            "shift".to_string(),
            130,
        )
        .unwrap_err();

        assert_eq!(err, ScheduleError::ViolatesParentConstraint);
    }

    #[test]
    fn move_task_clears_deviation_if_back_to_plan() {
        let protocol = sample_protocol();
        let start = NaiveDate::from_ymd_opt(2026, 2, 5).unwrap();
        let mut experiment =
            schedule_from_protocol(&protocol, start, "alice".to_string(), 100).unwrap();

        // Move B forward (+1): Feb 8 → Feb 9, cascades C to Feb 11
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

        // Move B back (-1): Feb 9 → Feb 8 (only B shifts, C stays at Feb 11)
        move_task_with_constraints(
            &mut experiment,
            &protocol,
            second,
            NaiveDate::from_ymd_opt(2026, 2, 8).unwrap(),
            "restored".to_string(),
            131,
        )
        .unwrap();

        // A: no deviation (never moved)
        assert!(experiment.tasks[0].deviation.is_none());
        // B: back to planned date → deviation cleared
        assert!(experiment.tasks[1].deviation.is_none());
        // C: still shifted from planned Feb 10 to Feb 11 → deviation remains
        assert!(experiment.tasks[2].deviation.is_some());
        assert_eq!(
            experiment.tasks[2].deviation.as_ref().unwrap().shifted_by_days,
            1
        );
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

        // Put second task on same day as first for ordering test.
        if let Some(t) = experiment.tasks.iter_mut().find(|t| t.id == second) {
            t.date = first_date;
            t.day_priority = 1;
        }

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

        if let Some(t) = experiment.tasks.iter_mut().find(|t| t.id == t1) {
            t.date = first_date;
            t.day_priority = 1;
        }

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

    #[test]
    fn schedules_multi_parent_step_from_latest_parent() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let c = Uuid::new_v4();
        let protocol = Protocol {
            id: Uuid::new_v4(),
            name: "ForkJoin".to_string(),
            description: "multi parent".to_string(),
            steps: vec![
                ProtocolStep {
                    id: a,
                    name: "A".to_string(),
                    details: "".to_string(),
                    parent_step_ids: vec![],
                    default_offset_days: 0,
                },
                ProtocolStep {
                    id: b,
                    name: "B".to_string(),
                    details: "".to_string(),
                    parent_step_ids: vec![a],
                    default_offset_days: 3,
                },
                ProtocolStep {
                    id: c,
                    name: "C".to_string(),
                    details: "".to_string(),
                    parent_step_ids: vec![a, b],
                    default_offset_days: 2,
                },
            ],
            created_by: String::new(),
            created_at: 1,
            updated_at: 1,
        };

        let start = NaiveDate::from_ymd_opt(2026, 2, 5).unwrap();
        let experiment =
            schedule_from_protocol(&protocol, start, "alice".to_string(), 100).unwrap();
        let by_step: std::collections::HashMap<Uuid, NaiveDate> =
            experiment.tasks.iter().map(|t| (t.step_id, t.date)).collect();

        assert_eq!(by_step[&a], NaiveDate::from_ymd_opt(2026, 2, 5).unwrap());
        assert_eq!(by_step[&b], NaiveDate::from_ymd_opt(2026, 2, 8).unwrap());
        assert_eq!(by_step[&c], NaiveDate::from_ymd_opt(2026, 2, 10).unwrap());
    }

    #[test]
    fn move_task_shifts_multi_parent_downstream_by_delta() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let c = Uuid::new_v4();
        let protocol = Protocol {
            id: Uuid::new_v4(),
            name: "ForkJoin".to_string(),
            description: "multi parent".to_string(),
            steps: vec![
                ProtocolStep {
                    id: a,
                    name: "A".to_string(),
                    details: "".to_string(),
                    parent_step_ids: vec![],
                    default_offset_days: 0,
                },
                ProtocolStep {
                    id: b,
                    name: "B".to_string(),
                    details: "".to_string(),
                    parent_step_ids: vec![a],
                    default_offset_days: 3,
                },
                ProtocolStep {
                    id: c,
                    name: "C".to_string(),
                    details: "".to_string(),
                    parent_step_ids: vec![a, b],
                    default_offset_days: 2,
                },
            ],
            created_by: String::new(),
            created_at: 1,
            updated_at: 1,
        };

        let start = NaiveDate::from_ymd_opt(2026, 2, 5).unwrap();
        let mut experiment =
            schedule_from_protocol(&protocol, start, "alice".to_string(), 100).unwrap();
        let b_task_id = experiment
            .tasks
            .iter()
            .find(|t| t.step_id == b)
            .map(|t| t.id)
            .unwrap();

        move_task_with_constraints(
            &mut experiment,
            &protocol,
            b_task_id,
            NaiveDate::from_ymd_opt(2026, 2, 10).unwrap(),
            "shift".to_string(),
            120,
        )
        .unwrap();

        let by_step: std::collections::HashMap<Uuid, NaiveDate> =
            experiment.tasks.iter().map(|t| (t.step_id, t.date)).collect();
        assert_eq!(by_step[&a], NaiveDate::from_ymd_opt(2026, 2, 5).unwrap());
        assert_eq!(by_step[&b], NaiveDate::from_ymd_opt(2026, 2, 10).unwrap());
        assert_eq!(by_step[&c], NaiveDate::from_ymd_opt(2026, 2, 12).unwrap());
    }

    #[test]
    fn move_multi_parent_child_before_other_parent_is_rejected() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let c = Uuid::new_v4();
        let protocol = Protocol {
            id: Uuid::new_v4(),
            name: "ForkJoin".to_string(),
            description: "multi parent".to_string(),
            steps: vec![
                ProtocolStep {
                    id: a,
                    name: "A".to_string(),
                    details: "".to_string(),
                    parent_step_ids: vec![],
                    default_offset_days: 0,
                },
                ProtocolStep {
                    id: b,
                    name: "B".to_string(),
                    details: "".to_string(),
                    parent_step_ids: vec![a],
                    default_offset_days: 3,
                },
                ProtocolStep {
                    id: c,
                    name: "C".to_string(),
                    details: "".to_string(),
                    parent_step_ids: vec![a, b],
                    default_offset_days: 2,
                },
            ],
            created_by: String::new(),
            created_at: 1,
            updated_at: 1,
        };

        let start = NaiveDate::from_ymd_opt(2026, 2, 5).unwrap();
        let mut experiment =
            schedule_from_protocol(&protocol, start, "alice".to_string(), 100).unwrap();
        let b_task_id = experiment
            .tasks
            .iter()
            .find(|t| t.step_id == b)
            .map(|t| t.id)
            .unwrap();

        let err = move_task_with_constraints(
            &mut experiment,
            &protocol,
            b_task_id,
            NaiveDate::from_ymd_opt(2026, 2, 1).unwrap(),
            "shift".to_string(),
            120,
        )
        .unwrap_err();

        assert_eq!(err, ScheduleError::ViolatesParentConstraint);
    }
}
