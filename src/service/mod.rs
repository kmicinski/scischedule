use std::sync::Arc;

use chrono::{Datelike, Utc};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    domain::{
        build_month_view, build_week_view, lock_experiment, move_task_with_constraints,
        reorder_task_for_day, schedule_from_protocol, validate_protocol, CreateProtocolRequest,
        CreateProtocolStepRequest, Experiment, ExperimentId, MonthView, MoveTaskRequest,
        PlanExperimentRequest, Protocol, ProtocolId, ProtocolStep, ReorderTaskRequest, WeekView,
    },
    repo::{RepoError, Repository},
};

#[derive(Debug, Error)]
pub enum ServiceError {
    #[error("repo error: {0}")]
    Repo(#[from] RepoError),
    #[error("schedule error: {0}")]
    Schedule(#[from] crate::domain::ScheduleError),
    #[error("not found")]
    NotFound,
}

pub struct AppService<R: Repository> {
    repo: Arc<R>,
}

impl<R: Repository> AppService<R> {
    pub fn new(repo: Arc<R>) -> Self {
        Self { repo }
    }

    pub fn create_protocol(&self, req: CreateProtocolRequest) -> Result<Protocol, ServiceError> {
        let now = Utc::now().timestamp();
        let protocol = Protocol {
            id: Uuid::new_v4(),
            name: req.name,
            description: req.description,
            steps: map_steps(req.steps),
            created_at: now,
            updated_at: now,
        };

        validate_protocol(&protocol)?;
        self.repo.upsert_protocol(&protocol)?;
        Ok(protocol)
    }

    pub fn list_protocols(&self) -> Result<Vec<Protocol>, ServiceError> {
        self.repo.list_protocols().map_err(Into::into)
    }

    pub fn plan_experiment(&self, req: PlanExperimentRequest) -> Result<Experiment, ServiceError> {
        let protocol = self.repo.get_protocol(req.protocol_id)?;
        let now = Utc::now().timestamp();
        let experiment = schedule_from_protocol(&protocol, req.start_date, req.created_by, now)?;
        self.repo.upsert_experiment(&experiment)?;
        Ok(experiment)
    }

    pub fn lock_experiment(&self, id: ExperimentId) -> Result<Experiment, ServiceError> {
        let experiment = self.repo.get_experiment(id)?;
        let now = Utc::now().timestamp();
        let experiment = lock_experiment(experiment, now);
        self.repo.upsert_experiment(&experiment)?;
        Ok(experiment)
    }

    pub fn move_task(
        &self,
        experiment_id: ExperimentId,
        req: MoveTaskRequest,
    ) -> Result<Experiment, ServiceError> {
        let mut experiment = self.repo.get_experiment(experiment_id)?;
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
    ) -> Result<Experiment, ServiceError> {
        let mut experiment = self.repo.get_experiment(experiment_id)?;
        let now = Utc::now().timestamp();
        reorder_task_for_day(&mut experiment, req.task_id, req.new_priority, now)?;
        self.repo.upsert_experiment(&experiment)?;
        Ok(experiment)
    }

    pub fn month_view(&self, year: i32, month: u32) -> Result<MonthView, ServiceError> {
        let experiments = self.repo.list_experiments()?;
        Ok(build_month_view(&experiments, year, month))
    }

    pub fn week_view(&self, year: i32, month: u32, day: u32) -> Result<WeekView, ServiceError> {
        let date =
            chrono::NaiveDate::from_ymd_opt(year, month, day).ok_or(ServiceError::NotFound)?;
        let weekday_offset = date.weekday().num_days_from_monday() as i64;
        let week_start = date - chrono::Duration::days(weekday_offset);
        let experiments = self.repo.list_experiments()?;
        Ok(build_week_view(&experiments, week_start))
    }

    pub fn list_experiments(&self) -> Result<Vec<Experiment>, ServiceError> {
        self.repo.list_experiments().map_err(Into::into)
    }

    pub fn get_protocol(&self, id: ProtocolId) -> Result<Protocol, ServiceError> {
        self.repo.get_protocol(id).map_err(Into::into)
    }
}

fn map_steps(steps: Vec<CreateProtocolStepRequest>) -> Vec<ProtocolStep> {
    let generated_ids: Vec<Uuid> = (0..steps.len()).map(|_| Uuid::new_v4()).collect();

    steps
        .into_iter()
        .enumerate()
        .map(|(idx, s)| ProtocolStep {
            id: generated_ids[idx],
            name: s.name,
            details: s.details,
            parent_step_id: s
                .parent_step_index
                .and_then(|p| generated_ids.get(p).copied()),
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
    }

    fn sample_create_protocol() -> CreateProtocolRequest {
        CreateProtocolRequest {
            name: "Protocol A".into(),
            description: "Desc".into(),
            steps: vec![
                CreateProtocolStepRequest {
                    name: "Step 1".into(),
                    details: "a".into(),
                    parent_step_index: None,
                    default_offset_days: 0,
                },
                CreateProtocolStepRequest {
                    name: "Step 2".into(),
                    details: "b".into(),
                    parent_step_index: None,
                    default_offset_days: 3,
                },
            ],
        }
    }

    #[test]
    fn create_and_list_protocols() {
        let repo = Arc::new(MemRepo::default());
        let svc = AppService::new(repo);

        let p = svc.create_protocol(sample_create_protocol()).unwrap();
        let all = svc.list_protocols().unwrap();

        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, p.id);
    }

    #[test]
    fn plan_and_lock_experiment() {
        let repo = Arc::new(MemRepo::default());
        let svc = AppService::new(repo);
        let p = svc.create_protocol(sample_create_protocol()).unwrap();

        let e = svc
            .plan_experiment(PlanExperimentRequest {
                protocol_id: p.id,
                start_date: NaiveDate::from_ymd_opt(2026, 2, 5).unwrap(),
                created_by: "alice".into(),
            })
            .unwrap();

        assert_eq!(e.status, ExperimentStatus::Draft);

        let locked = svc.lock_experiment(e.id).unwrap();
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
                    parent_step_index: None,
                    default_offset_days: 0,
                },
                CreateProtocolStepRequest {
                    name: "Step 2".into(),
                    details: "b".into(),
                    parent_step_index: Some(0),
                    default_offset_days: 3,
                },
            ],
        };
        let p = svc.create_protocol(req).unwrap();

        let e = svc
            .plan_experiment(PlanExperimentRequest {
                protocol_id: p.id,
                start_date: NaiveDate::from_ymd_opt(2026, 2, 5).unwrap(),
                created_by: "alice".into(),
            })
            .unwrap();

        let moved = svc
            .move_task(
                e.id,
                MoveTaskRequest {
                    task_id: e.tasks[1].id,
                    new_date: NaiveDate::from_ymd_opt(2026, 2, 9).unwrap(),
                    reason: "shift".into(),
                },
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
            )
            .unwrap();

        assert_eq!(reordered.tasks[1].day_priority, 0);
    }

    #[test]
    fn month_and_week_views_return_data() {
        let repo = Arc::new(MemRepo::default());
        let svc = AppService::new(repo);
        let p = svc.create_protocol(sample_create_protocol()).unwrap();

        svc.plan_experiment(PlanExperimentRequest {
            protocol_id: p.id,
            start_date: NaiveDate::from_ymd_opt(2026, 2, 5).unwrap(),
            created_by: "alice".into(),
        })
        .unwrap();

        let month = svc.month_view(2026, 2).unwrap();
        let week = svc.week_view(2026, 2, 5).unwrap();

        assert_eq!(month.month, 2);
        assert_eq!(week.days.len(), 7);
    }

    #[test]
    fn protocol_not_found_on_plan() {
        let repo = Arc::new(MemRepo::default());
        let svc = AppService::new(repo);

        let err = svc
            .plan_experiment(PlanExperimentRequest {
                protocol_id: Uuid::new_v4(),
                start_date: NaiveDate::from_ymd_opt(2026, 2, 5).unwrap(),
                created_by: "alice".into(),
            })
            .unwrap_err();

        assert!(matches!(err, ServiceError::Repo(RepoError::NotFound)));
    }
}
