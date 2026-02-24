use std::path::Path;

use thiserror::Error;

use crate::domain::{Experiment, ExperimentId, Protocol, ProtocolId, StandaloneTask, StandaloneTaskId};

#[derive(Debug, Error)]
pub enum RepoError {
    #[error("storage failure: {0}")]
    Storage(String),
    #[error("not found")]
    NotFound,
}

pub trait Repository: Send + Sync + 'static {
    fn upsert_protocol(&self, protocol: &Protocol) -> Result<(), RepoError>;
    fn list_protocols(&self) -> Result<Vec<Protocol>, RepoError>;
    fn get_protocol(&self, id: ProtocolId) -> Result<Protocol, RepoError>;

    fn upsert_experiment(&self, experiment: &Experiment) -> Result<(), RepoError>;
    fn list_experiments(&self) -> Result<Vec<Experiment>, RepoError>;
    fn get_experiment(&self, id: ExperimentId) -> Result<Experiment, RepoError>;

    fn delete_experiment(&self, id: ExperimentId) -> Result<(), RepoError>;

    fn delete_protocol(&self, id: ProtocolId) -> Result<(), RepoError>;

    fn upsert_standalone_task(&self, task: &StandaloneTask) -> Result<(), RepoError>;
    fn list_standalone_tasks(&self) -> Result<Vec<StandaloneTask>, RepoError>;
    fn get_standalone_task(&self, id: StandaloneTaskId) -> Result<StandaloneTask, RepoError>;
    fn delete_standalone_task(&self, id: StandaloneTaskId) -> Result<(), RepoError>;
}

pub struct SledRepo {
    db: sled::Db,
}

impl SledRepo {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, RepoError> {
        let db = sled::open(path).map_err(|e| RepoError::Storage(e.to_string()))?;
        Ok(Self { db })
    }

    fn key_protocol(id: ProtocolId) -> String {
        format!("protocol:{id}")
    }

    fn key_experiment(id: ExperimentId) -> String {
        format!("experiment:{id}")
    }

    fn key_standalone_task(id: StandaloneTaskId) -> String {
        format!("standalone_task:{id}")
    }
}

impl Repository for SledRepo {
    fn upsert_protocol(&self, protocol: &Protocol) -> Result<(), RepoError> {
        let key = Self::key_protocol(protocol.id);
        let value = serde_json::to_vec(protocol).map_err(|e| RepoError::Storage(e.to_string()))?;
        self.db
            .insert(key.as_bytes(), value)
            .map_err(|e| RepoError::Storage(e.to_string()))?;
        self.db
            .flush()
            .map_err(|e| RepoError::Storage(e.to_string()))?;
        Ok(())
    }

    fn list_protocols(&self) -> Result<Vec<Protocol>, RepoError> {
        let mut out = Vec::new();
        for item in self.db.scan_prefix("protocol:") {
            let (_, value) = item.map_err(|e| RepoError::Storage(e.to_string()))?;
            let protocol: Protocol =
                serde_json::from_slice(&value).map_err(|e| RepoError::Storage(e.to_string()))?;
            out.push(protocol);
        }

        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(out)
    }

    fn get_protocol(&self, id: ProtocolId) -> Result<Protocol, RepoError> {
        let key = Self::key_protocol(id);
        let value = self
            .db
            .get(key.as_bytes())
            .map_err(|e| RepoError::Storage(e.to_string()))?
            .ok_or(RepoError::NotFound)?;

        serde_json::from_slice(&value).map_err(|e| RepoError::Storage(e.to_string()))
    }

    fn upsert_experiment(&self, experiment: &Experiment) -> Result<(), RepoError> {
        let key = Self::key_experiment(experiment.id);
        let value =
            serde_json::to_vec(experiment).map_err(|e| RepoError::Storage(e.to_string()))?;
        self.db
            .insert(key.as_bytes(), value)
            .map_err(|e| RepoError::Storage(e.to_string()))?;
        self.db
            .flush()
            .map_err(|e| RepoError::Storage(e.to_string()))?;
        Ok(())
    }

    fn list_experiments(&self) -> Result<Vec<Experiment>, RepoError> {
        let mut out = Vec::new();
        for item in self.db.scan_prefix("experiment:") {
            let (_, value) = item.map_err(|e| RepoError::Storage(e.to_string()))?;
            let experiment: Experiment =
                serde_json::from_slice(&value).map_err(|e| RepoError::Storage(e.to_string()))?;
            out.push(experiment);
        }

        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(out)
    }

    fn get_experiment(&self, id: ExperimentId) -> Result<Experiment, RepoError> {
        let key = Self::key_experiment(id);
        let value = self
            .db
            .get(key.as_bytes())
            .map_err(|e| RepoError::Storage(e.to_string()))?
            .ok_or(RepoError::NotFound)?;

        serde_json::from_slice(&value).map_err(|e| RepoError::Storage(e.to_string()))
    }

    fn delete_experiment(&self, id: ExperimentId) -> Result<(), RepoError> {
        let key = Self::key_experiment(id);
        self.db
            .remove(key.as_bytes())
            .map_err(|e| RepoError::Storage(e.to_string()))?;
        self.db
            .flush()
            .map_err(|e| RepoError::Storage(e.to_string()))?;
        Ok(())
    }

    fn delete_protocol(&self, id: ProtocolId) -> Result<(), RepoError> {
        let key = Self::key_protocol(id);
        self.db
            .remove(key.as_bytes())
            .map_err(|e| RepoError::Storage(e.to_string()))?;
        self.db
            .flush()
            .map_err(|e| RepoError::Storage(e.to_string()))?;
        Ok(())
    }

    fn upsert_standalone_task(&self, task: &StandaloneTask) -> Result<(), RepoError> {
        let key = Self::key_standalone_task(task.id);
        let value = serde_json::to_vec(task).map_err(|e| RepoError::Storage(e.to_string()))?;
        self.db
            .insert(key.as_bytes(), value)
            .map_err(|e| RepoError::Storage(e.to_string()))?;
        self.db
            .flush()
            .map_err(|e| RepoError::Storage(e.to_string()))?;
        Ok(())
    }

    fn list_standalone_tasks(&self) -> Result<Vec<StandaloneTask>, RepoError> {
        let mut out = Vec::new();
        for item in self.db.scan_prefix("standalone_task:") {
            let (_, value) = item.map_err(|e| RepoError::Storage(e.to_string()))?;
            let task: StandaloneTask =
                serde_json::from_slice(&value).map_err(|e| RepoError::Storage(e.to_string()))?;
            out.push(task);
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(out)
    }

    fn get_standalone_task(&self, id: StandaloneTaskId) -> Result<StandaloneTask, RepoError> {
        let key = Self::key_standalone_task(id);
        let value = self
            .db
            .get(key.as_bytes())
            .map_err(|e| RepoError::Storage(e.to_string()))?
            .ok_or(RepoError::NotFound)?;
        serde_json::from_slice(&value).map_err(|e| RepoError::Storage(e.to_string()))
    }

    fn delete_standalone_task(&self, id: StandaloneTaskId) -> Result<(), RepoError> {
        let key = Self::key_standalone_task(id);
        self.db
            .remove(key.as_bytes())
            .map_err(|e| RepoError::Storage(e.to_string()))?;
        self.db
            .flush()
            .map_err(|e| RepoError::Storage(e.to_string()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDate;
    use uuid::Uuid;

    use super::*;
    use crate::domain::{ExperimentStatus, ProtocolStep, ScheduledTask};

    fn temp_repo() -> SledRepo {
        let p = std::env::temp_dir().join(format!("scischedule-test-{}", Uuid::new_v4()));
        SledRepo::open(p).unwrap()
    }

    #[test]
    fn protocol_round_trip() {
        let repo = temp_repo();
        let protocol = Protocol {
            id: Uuid::new_v4(),
            name: "A".into(),
            description: "D".into(),
            steps: vec![ProtocolStep {
                id: Uuid::new_v4(),
                name: "S".into(),
                details: "x".into(),
                parent_step_ids: vec![],
                default_offset_days: 0,
            }],
            created_by: String::new(),
            created_at: 1,
            updated_at: 2,
            archived: false,
        };

        repo.upsert_protocol(&protocol).unwrap();
        let got = repo.get_protocol(protocol.id).unwrap();
        assert_eq!(got.name, "A");
        assert_eq!(repo.list_protocols().unwrap().len(), 1);
    }

    #[test]
    fn experiment_round_trip() {
        let repo = temp_repo();
        let experiment = Experiment {
            id: Uuid::new_v4(),
            protocol_id: Uuid::new_v4(),
            protocol_name: "P".into(),
            status: ExperimentStatus::Draft,
            start_date: NaiveDate::from_ymd_opt(2026, 2, 5).unwrap(),
            tasks: vec![ScheduledTask {
                id: Uuid::new_v4(),
                step_id: Uuid::new_v4(),
                step_name: "Step".into(),
                date: NaiveDate::from_ymd_opt(2026, 2, 5).unwrap(),
                planned_date: NaiveDate::from_ymd_opt(2026, 2, 5).unwrap(),
                day_priority: 0,
                deviation: None,
                completed: false,
            }],
            created_by: "alice".into(),
            created_at: 10,
            updated_at: 11,
        };

        repo.upsert_experiment(&experiment).unwrap();
        let got = repo.get_experiment(experiment.id).unwrap();
        assert_eq!(got.protocol_name, "P");
        assert_eq!(repo.list_experiments().unwrap().len(), 1);
    }

    #[test]
    fn list_orders_by_updated_desc() {
        let repo = temp_repo();
        let p1 = Protocol {
            id: Uuid::new_v4(),
            name: "Old".into(),
            description: "D".into(),
            steps: vec![],
            created_by: String::new(),
            created_at: 1,
            updated_at: 2,
            archived: false,
        };
        let p2 = Protocol {
            id: Uuid::new_v4(),
            name: "New".into(),
            description: "D".into(),
            steps: vec![],
            created_by: String::new(),
            created_at: 1,
            updated_at: 9,
            archived: false,
        };

        repo.upsert_protocol(&p1).unwrap();
        repo.upsert_protocol(&p2).unwrap();

        let list = repo.list_protocols().unwrap();
        assert_eq!(list[0].name, "New");
        assert_eq!(list[1].name, "Old");
    }
}
