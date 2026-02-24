use std::sync::Arc;

use chrono::{Datelike, Utc};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    domain::{
        build_month_view, build_week_view, lock_experiment, move_task_with_constraints,
        reorder_task_for_day, schedule_from_protocol, validate_protocol,
        CreateProtocolRequest, CreateProtocolStepRequest, CreateStandaloneTaskRequest,
        Experiment, ExperimentId, MonthView, MoveTaskRequest, PlanExperimentRequest,
        Protocol, ProtocolId, ProtocolStep, ReorderTaskRequest, StandaloneTask,
        StandaloneTaskId, UpdateStandaloneTaskRequest, WeekView,
    },
    repo::{RepoError, Repository},
};

#[derive(Debug, Error)]
pub enum ServiceError {
    #[error("repo error: {0}")]
    Repo(#[from] RepoError),
    #[error("schedule error: {0}")]
    Schedule(#[from] crate::domain::ScheduleError),
    #[error("invalid protocol edit: {0}")]
    InvalidProtocolEdit(String),
    #[error("not found")]
    NotFound,
    #[error("forbidden")]
    Forbidden,
    #[error("unauthorized")]
    Unauthorized,
}

pub struct AppService<R: Repository> {
    repo: Arc<R>,
}

impl<R: Repository> AppService<R> {
    pub fn new(repo: Arc<R>) -> Self {
        Self { repo }
    }

    pub fn create_protocol(
        &self,
        req: CreateProtocolRequest,
        user: &str,
    ) -> Result<Protocol, ServiceError> {
        let now = Utc::now().timestamp();
        let protocol = Protocol {
            id: Uuid::new_v4(),
            name: req.name,
            description: req.description,
            steps: map_steps(req.steps),
            created_by: user.to_string(),
            created_at: now,
            updated_at: now,
        };

        validate_protocol(&protocol)?;
        self.repo.upsert_protocol(&protocol)?;
        Ok(protocol)
    }

    pub fn update_protocol(
        &self,
        id: ProtocolId,
        req: CreateProtocolRequest,
        user: &str,
    ) -> Result<Protocol, ServiceError> {
        let existing = self.repo.get_protocol(id)?;

        if !existing.created_by.is_empty() && existing.created_by != user {
            return Err(ServiceError::Forbidden);
        }

        let now = Utc::now().timestamp();
        let has_experiments = self
            .repo
            .list_experiments()?
            .iter()
            .any(|e| e.protocol_id == id);

        if has_experiments && req.steps.len() != existing.steps.len() {
            return Err(ServiceError::InvalidProtocolEdit(
                "cannot add or remove protocol steps after experiments are created".to_string(),
            ));
        }

        let existing_ids: Vec<Uuid> = existing.steps.iter().map(|s| s.id).collect();
        let protocol = Protocol {
            id: existing.id,
            name: req.name,
            description: req.description,
            steps: map_steps_with_existing_ids(req.steps, &existing_ids),
            created_by: existing.created_by,
            created_at: existing.created_at,
            updated_at: now,
        };

        validate_protocol(&protocol)?;
        self.repo.upsert_protocol(&protocol)?;
        Ok(protocol)
    }

    pub fn rename_step(
        &self,
        protocol_id: ProtocolId,
        step_id: crate::domain::StepId,
        new_name: String,
        user: &str,
    ) -> Result<Protocol, ServiceError> {
        if new_name.trim().is_empty() {
            return Err(ServiceError::InvalidProtocolEdit(
                "step name cannot be empty".to_string(),
            ));
        }

        let mut protocol = self.repo.get_protocol(protocol_id)?;

        if !protocol.created_by.is_empty() && protocol.created_by != user {
            return Err(ServiceError::Forbidden);
        }

        let step = protocol
            .steps
            .iter_mut()
            .find(|s| s.id == step_id)
            .ok_or(ServiceError::NotFound)?;
        step.name = new_name.clone();
        protocol.updated_at = Utc::now().timestamp();
        self.repo.upsert_protocol(&protocol)?;

        // Cascade: update step_name in all experiments using this protocol
        for mut exp in self.repo.list_experiments()? {
            if exp.protocol_id != protocol_id {
                continue;
            }
            let mut changed = false;
            for task in &mut exp.tasks {
                if task.step_id == step_id && task.step_name != new_name {
                    task.step_name = new_name.clone();
                    changed = true;
                }
            }
            if changed {
                exp.updated_at = Utc::now().timestamp();
                self.repo.upsert_experiment(&exp)?;
            }
        }

        Ok(protocol)
    }

    pub fn list_protocols(&self) -> Result<Vec<Protocol>, ServiceError> {
        self.repo.list_protocols().map_err(Into::into)
    }

    pub fn plan_experiment(
        &self,
        req: PlanExperimentRequest,
        user: &str,
    ) -> Result<Experiment, ServiceError> {
        let protocol = self.repo.get_protocol(req.protocol_id)?;
        let now = Utc::now().timestamp();
        let experiment =
            schedule_from_protocol(&protocol, req.start_date, user.to_string(), now)?;
        self.repo.upsert_experiment(&experiment)?;
        Ok(experiment)
    }

    pub fn lock_experiment(
        &self,
        id: ExperimentId,
        user: &str,
    ) -> Result<Experiment, ServiceError> {
        let experiment = self.repo.get_experiment(id)?;
        if experiment.created_by != user {
            return Err(ServiceError::Forbidden);
        }
        let now = Utc::now().timestamp();
        let experiment = lock_experiment(experiment, now);
        self.repo.upsert_experiment(&experiment)?;
        Ok(experiment)
    }

    pub fn move_task(
        &self,
        experiment_id: ExperimentId,
        req: MoveTaskRequest,
        user: &str,
    ) -> Result<Experiment, ServiceError> {
        let mut experiment = self.repo.get_experiment(experiment_id)?;
        if experiment.created_by != user {
            return Err(ServiceError::Forbidden);
        }
        let protocol = self.repo.get_protocol(experiment.protocol_id)?;
        let now = Utc::now().timestamp();

        move_task_with_constraints(
            &mut experiment,
            &protocol,
            req.task_id,
            req.new_date,
            req.reason,
            now,
        )?;

        self.repo.upsert_experiment(&experiment)?;
        Ok(experiment)
    }

    pub fn reorder_task(
        &self,
        experiment_id: ExperimentId,
        req: ReorderTaskRequest,
        user: &str,
    ) -> Result<Experiment, ServiceError> {
        let mut experiment = self.repo.get_experiment(experiment_id)?;
        if experiment.created_by != user {
            return Err(ServiceError::Forbidden);
        }
        let now = Utc::now().timestamp();
        reorder_task_for_day(&mut experiment, req.task_id, req.new_priority, now)?;
        self.repo.upsert_experiment(&experiment)?;
        Ok(experiment)
    }

    pub fn toggle_task_completed(
        &self,
        experiment_id: ExperimentId,
        task_id: crate::domain::TaskId,
        user: &str,
    ) -> Result<Experiment, ServiceError> {
        let mut experiment = self.repo.get_experiment(experiment_id)?;
        if experiment.created_by != user {
            return Err(ServiceError::Forbidden);
        }
        let task = experiment
            .tasks
            .iter_mut()
            .find(|t| t.id == task_id)
            .ok_or(ServiceError::NotFound)?;
        task.completed = !task.completed;
        experiment.updated_at = Utc::now().timestamp();
        self.repo.upsert_experiment(&experiment)?;
        Ok(experiment)
    }

    pub fn rename_task(
        &self,
        experiment_id: ExperimentId,
        task_id: crate::domain::TaskId,
        new_name: String,
        user: &str,
    ) -> Result<Experiment, ServiceError> {
        if new_name.trim().is_empty() {
            return Err(ServiceError::InvalidProtocolEdit(
                "task name cannot be empty".to_string(),
            ));
        }
        let mut experiment = self.repo.get_experiment(experiment_id)?;
        if experiment.created_by != user {
            return Err(ServiceError::Forbidden);
        }
        let task = experiment
            .tasks
            .iter_mut()
            .find(|t| t.id == task_id)
            .ok_or(ServiceError::NotFound)?;
        task.step_name = new_name;
        experiment.updated_at = Utc::now().timestamp();
        self.repo.upsert_experiment(&experiment)?;
        Ok(experiment)
    }

    pub fn month_view(
        &self,
        year: i32,
        month: u32,
        user: &str,
    ) -> Result<MonthView, ServiceError> {
        let experiments: Vec<Experiment> = self
            .repo
            .list_experiments()?
            .into_iter()
            .filter(|e| e.created_by == user)
            .collect();
        Ok(build_month_view(&experiments, year, month))
    }

    pub fn week_view(
        &self,
        year: i32,
        month: u32,
        day: u32,
        user: &str,
    ) -> Result<WeekView, ServiceError> {
        let date =
            chrono::NaiveDate::from_ymd_opt(year, month, day).ok_or(ServiceError::NotFound)?;
        let weekday_offset = date.weekday().num_days_from_monday() as i64;
        let week_start = date - chrono::Duration::days(weekday_offset);
        let experiments: Vec<Experiment> = self
            .repo
            .list_experiments()?
            .into_iter()
            .filter(|e| e.created_by == user)
            .collect();
        Ok(build_week_view(&experiments, week_start))
    }

    pub fn list_experiments(&self, user: &str) -> Result<Vec<Experiment>, ServiceError> {
        Ok(self
            .repo
            .list_experiments()?
            .into_iter()
            .filter(|e| e.created_by == user)
            .collect())
    }

    pub fn get_protocol(&self, id: ProtocolId) -> Result<Protocol, ServiceError> {
        self.repo.get_protocol(id).map_err(Into::into)
    }

    pub fn delete_experiment(
        &self,
        id: ExperimentId,
        user: &str,
    ) -> Result<(), ServiceError> {
        let experiment = self.repo.get_experiment(id)?;
        if experiment.created_by != user {
            return Err(ServiceError::Forbidden);
        }
        self.repo.delete_experiment(id)?;
        Ok(())
    }

    pub fn delete_protocol(
        &self,
        id: ProtocolId,
        user: &str,
    ) -> Result<(), ServiceError> {
        let protocol = self.repo.get_protocol(id)?;
        if !protocol.created_by.is_empty() && protocol.created_by != user {
            return Err(ServiceError::Forbidden);
        }
        let has_experiments = self
            .repo
            .list_experiments()?
            .iter()
            .any(|e| e.protocol_id == id);
        if has_experiments {
            return Err(ServiceError::InvalidProtocolEdit(
                "delete experiments using this protocol first".into(),
            ));
        }
        self.repo.delete_protocol(id)?;
        Ok(())
    }

    pub fn create_standalone_task(
        &self,
        req: CreateStandaloneTaskRequest,
        user: &str,
    ) -> Result<StandaloneTask, ServiceError> {
        if let Some(c) = req.color_tag {
            if c >= 8 {
                return Err(ServiceError::InvalidProtocolEdit(
                    "color_tag must be 0–7".to_string(),
                ));
            }
        }
        let now = Utc::now().timestamp();
        let task = StandaloneTask {
            id: Uuid::new_v4(),
            title: req.title,
            notes: req.notes.unwrap_or_default(),
            time_of_day: req.time_of_day,
            color_tag: req.color_tag,
            date: req.date,
            completed: false,
            sort_order: 0,
            created_by: user.to_string(),
            created_at: now,
            updated_at: now,
        };
        self.repo.upsert_standalone_task(&task)?;
        Ok(task)
    }

    pub fn update_standalone_task(
        &self,
        id: StandaloneTaskId,
        req: UpdateStandaloneTaskRequest,
        user: &str,
    ) -> Result<StandaloneTask, ServiceError> {
        let mut task = self.repo.get_standalone_task(id)?;
        if task.created_by != user {
            return Err(ServiceError::Forbidden);
        }
        if let Some(title) = req.title {
            task.title = title;
        }
        if let Some(notes) = req.notes {
            task.notes = notes;
        }
        if let Some(time_of_day) = req.time_of_day {
            task.time_of_day = time_of_day;
        }
        if let Some(color_tag) = req.color_tag {
            if let Some(c) = color_tag {
                if c >= 8 {
                    return Err(ServiceError::InvalidProtocolEdit(
                        "color_tag must be 0–7".to_string(),
                    ));
                }
            }
            task.color_tag = color_tag;
        }
        if let Some(date) = req.date {
            task.date = date;
        }
        if let Some(completed) = req.completed {
            task.completed = completed;
        }
        if let Some(sort_order) = req.sort_order {
            task.sort_order = sort_order;
        }
        task.updated_at = Utc::now().timestamp();
        self.repo.upsert_standalone_task(&task)?;
        Ok(task)
    }

    pub fn list_standalone_tasks(
        &self,
        user: &str,
    ) -> Result<Vec<StandaloneTask>, ServiceError> {
        Ok(self
            .repo
            .list_standalone_tasks()?
            .into_iter()
            .filter(|t| t.created_by == user)
            .collect())
    }

    pub fn delete_standalone_task(
        &self,
        id: StandaloneTaskId,
        user: &str,
    ) -> Result<(), ServiceError> {
        let task = self.repo.get_standalone_task(id)?;
        if task.created_by != user {
            return Err(ServiceError::Forbidden);
        }
        self.repo.delete_standalone_task(id)?;
        Ok(())
    }
}

fn map_steps(steps: Vec<CreateProtocolStepRequest>) -> Vec<ProtocolStep> {
    map_steps_with_existing_ids(steps, &[])
}

fn map_steps_with_existing_ids(
    steps: Vec<CreateProtocolStepRequest>,
    existing_ids: &[Uuid],
) -> Vec<ProtocolStep> {
    let generated_ids: Vec<Uuid> = (0..steps.len())
        .map(|idx| existing_ids.get(idx).copied().unwrap_or_else(Uuid::new_v4))
        .collect();

    steps
        .into_iter()
        .enumerate()
        .map(|(idx, s)| ProtocolStep {
            id: generated_ids[idx],
            name: s.name,
            details: s.details,
            parent_step_ids: s
                .parent_step_indexes
                .into_iter()
                .filter_map(|p| generated_ids.get(p).copied())
                .filter(|parent_id| *parent_id != generated_ids[idx])
                .fold(Vec::new(), |mut out, parent_id| {
                    if !out.contains(&parent_id) {
                        out.push(parent_id);
                    }
                    out
                }),
            default_offset_days: s.default_offset_days,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use chrono::NaiveDate;
    use uuid::Uuid;

    use super::*;
    use crate::{domain::ExperimentStatus, repo::Repository};

    #[derive(Default)]
    struct MemRepo {
        protocols: Mutex<Vec<Protocol>>,
        experiments: Mutex<Vec<Experiment>>,
        standalone_tasks: Mutex<Vec<StandaloneTask>>,
    }

    impl Repository for MemRepo {
        fn upsert_protocol(&self, protocol: &Protocol) -> Result<(), RepoError> {
            let mut protocols = self.protocols.lock().unwrap();
            if let Some(existing) = protocols.iter_mut().find(|p| p.id == protocol.id) {
                *existing = protocol.clone();
            } else {
                protocols.push(protocol.clone());
            }
            Ok(())
        }

        fn list_protocols(&self) -> Result<Vec<Protocol>, RepoError> {
            Ok(self.protocols.lock().unwrap().clone())
        }

        fn get_protocol(&self, id: ProtocolId) -> Result<Protocol, RepoError> {
            self.protocols
                .lock()
                .unwrap()
                .iter()
                .find(|p| p.id == id)
                .cloned()
                .ok_or(RepoError::NotFound)
        }

        fn upsert_experiment(&self, experiment: &Experiment) -> Result<(), RepoError> {
            let mut experiments = self.experiments.lock().unwrap();
            if let Some(existing) = experiments.iter_mut().find(|e| e.id == experiment.id) {
                *existing = experiment.clone();
            } else {
                experiments.push(experiment.clone());
            }
            Ok(())
        }

        fn list_experiments(&self) -> Result<Vec<Experiment>, RepoError> {
            Ok(self.experiments.lock().unwrap().clone())
        }

        fn get_experiment(&self, id: ExperimentId) -> Result<Experiment, RepoError> {
            self.experiments
                .lock()
                .unwrap()
                .iter()
                .find(|e| e.id == id)
                .cloned()
                .ok_or(RepoError::NotFound)
        }

        fn delete_experiment(&self, id: ExperimentId) -> Result<(), RepoError> {
            let mut experiments = self.experiments.lock().unwrap();
            experiments.retain(|e| e.id != id);
            Ok(())
        }

        fn delete_protocol(&self, id: ProtocolId) -> Result<(), RepoError> {
            let mut protocols = self.protocols.lock().unwrap();
            protocols.retain(|p| p.id != id);
            Ok(())
        }

        fn upsert_standalone_task(&self, task: &StandaloneTask) -> Result<(), RepoError> {
            let mut tasks = self.standalone_tasks.lock().unwrap();
            if let Some(existing) = tasks.iter_mut().find(|t| t.id == task.id) {
                *existing = task.clone();
            } else {
                tasks.push(task.clone());
            }
            Ok(())
        }

        fn list_standalone_tasks(&self) -> Result<Vec<StandaloneTask>, RepoError> {
            Ok(self.standalone_tasks.lock().unwrap().clone())
        }

        fn get_standalone_task(&self, id: StandaloneTaskId) -> Result<StandaloneTask, RepoError> {
            self.standalone_tasks
                .lock()
                .unwrap()
                .iter()
                .find(|t| t.id == id)
                .cloned()
                .ok_or(RepoError::NotFound)
        }

        fn delete_standalone_task(&self, id: StandaloneTaskId) -> Result<(), RepoError> {
            let mut tasks = self.standalone_tasks.lock().unwrap();
            tasks.retain(|t| t.id != id);
            Ok(())
        }
    }

    fn sample_create_protocol() -> CreateProtocolRequest {
        CreateProtocolRequest {
            name: "Protocol A".into(),
            description: "Desc".into(),
            steps: vec![
                CreateProtocolStepRequest {
                    name: "Step 1".into(),
                    details: "a".into(),
                    parent_step_indexes: vec![],
                    default_offset_days: 0,
                },
                CreateProtocolStepRequest {
                    name: "Step 2".into(),
                    details: "b".into(),
                    parent_step_indexes: vec![],
                    default_offset_days: 3,
                },
            ],
        }
    }

    #[test]
    fn create_and_list_protocols() {
        let repo = Arc::new(MemRepo::default());
        let svc = AppService::new(repo);

        let p = svc
            .create_protocol(sample_create_protocol(), "alice")
            .unwrap();
        let all = svc.list_protocols().unwrap();

        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, p.id);
        assert_eq!(all[0].created_by, "alice");
    }

    #[test]
    fn update_protocol_updates_existing_fields() {
        let repo = Arc::new(MemRepo::default());
        let svc = AppService::new(repo);
        let p = svc
            .create_protocol(sample_create_protocol(), "alice")
            .unwrap();
        let original_ids: Vec<Uuid> = p.steps.iter().map(|s| s.id).collect();

        let updated = svc
            .update_protocol(
                p.id,
                CreateProtocolRequest {
                    name: "Protocol A Edited".into(),
                    description: "Edited".into(),
                    steps: vec![
                        CreateProtocolStepRequest {
                            name: "Step 1 edited".into(),
                            details: "aa".into(),
                            parent_step_indexes: vec![],
                            default_offset_days: 0,
                        },
                        CreateProtocolStepRequest {
                            name: "Step 2 edited".into(),
                            details: "bb".into(),
                            parent_step_indexes: vec![0],
                            default_offset_days: 4,
                        },
                    ],
                },
                "alice",
            )
            .unwrap();

        assert_eq!(updated.name, "Protocol A Edited");
        assert_eq!(updated.description, "Edited");
        assert_eq!(updated.steps[0].id, original_ids[0]);
        assert_eq!(updated.steps[1].id, original_ids[1]);
        assert_eq!(updated.steps[1].parent_step_ids, vec![original_ids[0]]);
        assert_eq!(updated.steps[1].default_offset_days, 4);
    }

    #[test]
    fn update_protocol_rejects_step_count_change_when_experiment_exists() {
        let repo = Arc::new(MemRepo::default());
        let svc = AppService::new(repo);
        let p = svc
            .create_protocol(sample_create_protocol(), "alice")
            .unwrap();

        svc.plan_experiment(
            PlanExperimentRequest {
                protocol_id: p.id,
                start_date: NaiveDate::from_ymd_opt(2026, 2, 5).unwrap(),
            },
            "alice",
        )
        .unwrap();

        let err = svc
            .update_protocol(
                p.id,
                CreateProtocolRequest {
                    name: "Protocol A Edited".into(),
                    description: "Edited".into(),
                    steps: vec![
                        CreateProtocolStepRequest {
                            name: "Step 1".into(),
                            details: "a".into(),
                            parent_step_indexes: vec![],
                            default_offset_days: 0,
                        },
                        CreateProtocolStepRequest {
                            name: "Step 2".into(),
                            details: "b".into(),
                            parent_step_indexes: vec![0],
                            default_offset_days: 3,
                        },
                        CreateProtocolStepRequest {
                            name: "Step 3".into(),
                            details: "c".into(),
                            parent_step_indexes: vec![1],
                            default_offset_days: 2,
                        },
                    ],
                },
                "alice",
            )
            .unwrap_err();

        assert!(matches!(err, ServiceError::InvalidProtocolEdit(_)));
    }

    #[test]
    fn plan_and_lock_experiment() {
        let repo = Arc::new(MemRepo::default());
        let svc = AppService::new(repo);
        let p = svc
            .create_protocol(sample_create_protocol(), "alice")
            .unwrap();

        let e = svc
            .plan_experiment(
                PlanExperimentRequest {
                    protocol_id: p.id,
                    start_date: NaiveDate::from_ymd_opt(2026, 2, 5).unwrap(),
                },
                "alice",
            )
            .unwrap();

        assert_eq!(e.status, ExperimentStatus::Draft);

        let locked = svc.lock_experiment(e.id, "alice").unwrap();
        assert_eq!(locked.status, ExperimentStatus::Live);
    }

    #[test]
    fn move_and_reorder_task() {
        let repo = Arc::new(MemRepo::default());
        let svc = AppService::new(repo);

        let req = CreateProtocolRequest {
            name: "Protocol A".into(),
            description: "Desc".into(),
            steps: vec![
                CreateProtocolStepRequest {
                    name: "Step 1".into(),
                    details: "a".into(),
                    parent_step_indexes: vec![],
                    default_offset_days: 0,
                },
                CreateProtocolStepRequest {
                    name: "Step 2".into(),
                    details: "b".into(),
                    parent_step_indexes: vec![0],
                    default_offset_days: 3,
                },
            ],
        };
        let p = svc.create_protocol(req, "alice").unwrap();

        let e = svc
            .plan_experiment(
                PlanExperimentRequest {
                    protocol_id: p.id,
                    start_date: NaiveDate::from_ymd_opt(2026, 2, 5).unwrap(),
                },
                "alice",
            )
            .unwrap();

        let moved = svc
            .move_task(
                e.id,
                MoveTaskRequest {
                    task_id: e.tasks[1].id,
                    new_date: NaiveDate::from_ymd_opt(2026, 2, 9).unwrap(),
                    reason: "shift".into(),
                },
                "alice",
            )
            .unwrap();
        assert_eq!(
            moved.tasks[1].date,
            NaiveDate::from_ymd_opt(2026, 2, 9).unwrap()
        );

        let reordered = svc
            .reorder_task(
                e.id,
                ReorderTaskRequest {
                    task_id: moved.tasks[1].id,
                    new_priority: -10,
                },
                "alice",
            )
            .unwrap();

        assert_eq!(reordered.tasks[1].day_priority, 0);
    }

    #[test]
    fn month_and_week_views_return_data() {
        let repo = Arc::new(MemRepo::default());
        let svc = AppService::new(repo);
        let p = svc
            .create_protocol(sample_create_protocol(), "alice")
            .unwrap();

        svc.plan_experiment(
            PlanExperimentRequest {
                protocol_id: p.id,
                start_date: NaiveDate::from_ymd_opt(2026, 2, 5).unwrap(),
            },
            "alice",
        )
        .unwrap();

        let month = svc.month_view(2026, 2, "alice").unwrap();
        let week = svc.week_view(2026, 2, 5, "alice").unwrap();

        assert_eq!(month.month, 2);
        assert_eq!(week.days.len(), 7);
    }

    #[test]
    fn protocol_not_found_on_plan() {
        let repo = Arc::new(MemRepo::default());
        let svc = AppService::new(repo);

        let err = svc
            .plan_experiment(
                PlanExperimentRequest {
                    protocol_id: Uuid::new_v4(),
                    start_date: NaiveDate::from_ymd_opt(2026, 2, 5).unwrap(),
                },
                "alice",
            )
            .unwrap_err();

        assert!(matches!(err, ServiceError::Repo(RepoError::NotFound)));
    }

    #[test]
    fn update_protocol_forbidden_for_other_user() {
        let repo = Arc::new(MemRepo::default());
        let svc = AppService::new(repo);
        let p = svc
            .create_protocol(sample_create_protocol(), "alice")
            .unwrap();

        let err = svc
            .update_protocol(p.id, sample_create_protocol(), "bob")
            .unwrap_err();
        assert!(matches!(err, ServiceError::Forbidden));
    }

    #[test]
    fn lock_experiment_forbidden_for_other_user() {
        let repo = Arc::new(MemRepo::default());
        let svc = AppService::new(repo);
        let p = svc
            .create_protocol(sample_create_protocol(), "alice")
            .unwrap();
        let e = svc
            .plan_experiment(
                PlanExperimentRequest {
                    protocol_id: p.id,
                    start_date: NaiveDate::from_ymd_opt(2026, 2, 5).unwrap(),
                },
                "alice",
            )
            .unwrap();

        let err = svc.lock_experiment(e.id, "bob").unwrap_err();
        assert!(matches!(err, ServiceError::Forbidden));
    }

    #[test]
    fn list_experiments_filters_by_user() {
        let repo = Arc::new(MemRepo::default());
        let svc = AppService::new(repo);
        let p = svc
            .create_protocol(sample_create_protocol(), "alice")
            .unwrap();

        svc.plan_experiment(
            PlanExperimentRequest {
                protocol_id: p.id,
                start_date: NaiveDate::from_ymd_opt(2026, 2, 5).unwrap(),
            },
            "alice",
        )
        .unwrap();

        svc.plan_experiment(
            PlanExperimentRequest {
                protocol_id: p.id,
                start_date: NaiveDate::from_ymd_opt(2026, 2, 10).unwrap(),
            },
            "bob",
        )
        .unwrap();

        assert_eq!(svc.list_experiments("alice").unwrap().len(), 1);
        assert_eq!(svc.list_experiments("bob").unwrap().len(), 1);
        assert_eq!(svc.list_experiments("charlie").unwrap().len(), 0);
    }

    #[test]
    fn month_view_filters_by_user() {
        let repo = Arc::new(MemRepo::default());
        let svc = AppService::new(repo);
        let p = svc
            .create_protocol(sample_create_protocol(), "alice")
            .unwrap();

        svc.plan_experiment(
            PlanExperimentRequest {
                protocol_id: p.id,
                start_date: NaiveDate::from_ymd_opt(2026, 2, 5).unwrap(),
            },
            "alice",
        )
        .unwrap();

        svc.plan_experiment(
            PlanExperimentRequest {
                protocol_id: p.id,
                start_date: NaiveDate::from_ymd_opt(2026, 2, 5).unwrap(),
            },
            "bob",
        )
        .unwrap();

        let alice_month = svc.month_view(2026, 2, "alice").unwrap();
        let bob_month = svc.month_view(2026, 2, "bob").unwrap();
        let charlie_month = svc.month_view(2026, 2, "charlie").unwrap();

        let alice_tasks: usize = alice_month.cells.iter().map(|c| c.tasks.len()).sum();
        let bob_tasks: usize = bob_month.cells.iter().map(|c| c.tasks.len()).sum();
        let charlie_tasks: usize = charlie_month.cells.iter().map(|c| c.tasks.len()).sum();

        assert_eq!(alice_tasks, 2);
        assert_eq!(bob_tasks, 2);
        assert_eq!(charlie_tasks, 0);
    }
}
