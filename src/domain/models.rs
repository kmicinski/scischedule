use chrono::NaiveDate;
use serde::{de::Deserializer, Deserialize, Serialize};
use uuid::Uuid;

pub type ProtocolId = Uuid;
pub type StepId = Uuid;
pub type DraftId = Uuid;
pub type ExperimentId = Uuid;
pub type TaskId = Uuid;
pub type StandaloneTaskId = Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Protocol {
    pub id: ProtocolId,
    pub name: String,
    pub description: String,
    pub steps: Vec<ProtocolStep>,
    #[serde(default)]
    pub created_by: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProtocolStep {
    pub id: StepId,
    pub name: String,
    pub details: String,
    #[serde(
        default,
        alias = "parent_step_id",
        deserialize_with = "deserialize_parent_step_ids"
    )]
    pub parent_step_ids: Vec<StepId>,
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
    #[serde(default)]
    pub completed: bool,
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
    #[serde(
        default,
        alias = "parent_step_index",
        deserialize_with = "deserialize_parent_step_indexes"
    )]
    pub parent_step_indexes: Vec<usize>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StandaloneTask {
    pub id: StandaloneTaskId,
    pub title: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub time_of_day: Option<String>,
    #[serde(default)]
    pub color_tag: Option<u8>,
    pub date: Option<NaiveDate>,
    pub completed: bool,
    #[serde(default)]
    pub sort_order: i32,
    pub created_by: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreateStandaloneTaskRequest {
    pub title: String,
    #[serde(default)]
    pub date: Option<NaiveDate>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub time_of_day: Option<String>,
    #[serde(default)]
    pub color_tag: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateStandaloneTaskRequest {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub time_of_day: Option<Option<String>>,
    #[serde(default)]
    pub color_tag: Option<Option<u8>>,
    #[serde(default, deserialize_with = "deserialize_double_option_date")]
    pub date: Option<Option<NaiveDate>>,
    #[serde(default)]
    pub completed: Option<bool>,
    #[serde(default)]
    pub sort_order: Option<i32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum MaybeMany<T> {
    One(T),
    Many(Vec<T>),
}

fn deserialize_double_option_date<'de, D>(deserializer: D) -> Result<Option<Option<NaiveDate>>, D::Error>
where
    D: Deserializer<'de>,
{
    // When the field is present, deserialize its value.
    // null → Some(None) (clear the date), "2026-02-23" → Some(Some(date))
    Ok(Some(Option::<NaiveDate>::deserialize(deserializer)?))
}

fn deserialize_parent_step_ids<'de, D>(deserializer: D) -> Result<Vec<StepId>, D::Error>
where
    D: Deserializer<'de>,
{
    match Option::<MaybeMany<StepId>>::deserialize(deserializer)? {
        None => Ok(Vec::new()),
        Some(MaybeMany::One(id)) => Ok(vec![id]),
        Some(MaybeMany::Many(ids)) => Ok(ids),
    }
}

fn deserialize_parent_step_indexes<'de, D>(deserializer: D) -> Result<Vec<usize>, D::Error>
where
    D: Deserializer<'de>,
{
    match Option::<MaybeMany<usize>>::deserialize(deserializer)? {
        None => Ok(Vec::new()),
        Some(MaybeMany::One(idx)) => Ok(vec![idx]),
        Some(MaybeMany::Many(indexes)) => Ok(indexes),
    }
}
