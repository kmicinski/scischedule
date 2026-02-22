use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub type ProtocolId = Uuid;
pub type StepId = Uuid;
pub type DraftId = Uuid;
pub type ExperimentId = Uuid;
pub type TaskId = Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Protocol {
    pub id: ProtocolId,
    pub name: String,
    pub description: String,
    pub steps: Vec<ProtocolStep>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProtocolStep {
    pub id: StepId,
    pub name: String,
    pub details: String,
    pub parent_step_id: Option<StepId>,
    pub default_offset_days: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ExperimentStatus {
    Draft,
    Live,
    Complete,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScheduledTask {
    pub id: TaskId,
    pub step_id: StepId,
    pub step_name: String,
    pub date: NaiveDate,
    pub planned_date: NaiveDate,
    pub day_priority: i32,
    pub deviation: Option<Deviation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Deviation {
    pub reason: String,
    pub shifted_by_days: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Experiment {
    pub id: ExperimentId,
    pub protocol_id: ProtocolId,
    pub protocol_name: String,
    pub status: ExperimentStatus,
    pub start_date: NaiveDate,
    pub tasks: Vec<ScheduledTask>,
    pub created_by: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MonthCell {
    pub date: NaiveDate,
    pub tasks: Vec<ScheduledTask>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WeekDay {
    pub date: NaiveDate,
    pub tasks: Vec<ScheduledTask>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MonthView {
    pub year: i32,
    pub month: u32,
    pub cells: Vec<MonthCell>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WeekView {
    pub week_start: NaiveDate,
    pub days: Vec<WeekDay>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreateProtocolStepRequest {
    pub name: String,
    pub details: String,
    #[serde(default)]
    pub parent_step_index: Option<usize>,
    pub default_offset_days: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreateProtocolRequest {
    pub name: String,
    pub description: String,
    pub steps: Vec<CreateProtocolStepRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanExperimentRequest {
    pub protocol_id: ProtocolId,
    pub start_date: NaiveDate,
    pub created_by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MoveTaskRequest {
    pub task_id: TaskId,
    pub new_date: NaiveDate,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReorderTaskRequest {
    pub task_id: TaskId,
    pub new_priority: i32,
}
