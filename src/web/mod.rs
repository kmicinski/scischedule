use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{Html, IntoResponse},
    routing::{get, patch, post},
    Json, Router,
};
use serde::Deserialize;
use tower_http::{cors::CorsLayer, services::ServeDir, trace::TraceLayer};
use uuid::Uuid;

use crate::{
    domain::{CreateProtocolRequest, MoveTaskRequest, PlanExperimentRequest, ReorderTaskRequest},
    repo::SledRepo,
    service::{AppService, ServiceError},
};

pub type AppState = Arc<AppService<SledRepo>>;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/api/protocols", get(list_protocols).post(create_protocol))
        .route("/api/protocols/:id", get(get_protocol))
        .route(
            "/api/experiments",
            get(list_experiments).post(plan_experiment),
        )
        .route("/api/experiments/:id/lock", post(lock_experiment))
        .route("/api/experiments/:id/tasks/move", patch(move_task))
        .route("/api/experiments/:id/tasks/reorder", patch(reorder_task))
        .route("/api/views/month", get(month_view))
        .route("/api/views/week", get(week_view))
        .nest_service("/static", ServeDir::new("static"))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn index() -> impl IntoResponse {
    Html(include_str!("../../static/index.html"))
}

async fn create_protocol(
    State(service): State<AppState>,
    Json(req): Json<CreateProtocolRequest>,
) -> Result<Json<crate::domain::Protocol>, ApiError> {
    Ok(Json(service.create_protocol(req)?))
}

async fn list_protocols(
    State(service): State<AppState>,
) -> Result<Json<Vec<crate::domain::Protocol>>, ApiError> {
    Ok(Json(service.list_protocols()?))
}

async fn get_protocol(
    State(service): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<crate::domain::Protocol>, ApiError> {
    Ok(Json(service.get_protocol(id)?))
}

async fn plan_experiment(
    State(service): State<AppState>,
    Json(req): Json<PlanExperimentRequest>,
) -> Result<Json<crate::domain::Experiment>, ApiError> {
    Ok(Json(service.plan_experiment(req)?))
}

async fn list_experiments(
    State(service): State<AppState>,
) -> Result<Json<Vec<crate::domain::Experiment>>, ApiError> {
    Ok(Json(service.list_experiments()?))
}

async fn lock_experiment(
    State(service): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<crate::domain::Experiment>, ApiError> {
    Ok(Json(service.lock_experiment(id)?))
}

async fn move_task(
    State(service): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<MoveTaskRequest>,
) -> Result<Json<crate::domain::Experiment>, ApiError> {
    Ok(Json(service.move_task(id, req)?))
}

async fn reorder_task(
    State(service): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<ReorderTaskRequest>,
) -> Result<Json<crate::domain::Experiment>, ApiError> {
    Ok(Json(service.reorder_task(id, req)?))
}

#[derive(Debug, Deserialize)]
struct MonthQuery {
    year: i32,
    month: u32,
}

#[derive(Debug, Deserialize)]
struct WeekQuery {
    year: i32,
    month: u32,
    day: u32,
}

async fn month_view(
    State(service): State<AppState>,
    Query(query): Query<MonthQuery>,
) -> Result<Json<crate::domain::MonthView>, ApiError> {
    Ok(Json(service.month_view(query.year, query.month)?))
}

async fn week_view(
    State(service): State<AppState>,
    Query(query): Query<WeekQuery>,
) -> Result<Json<crate::domain::WeekView>, ApiError> {
    Ok(Json(service.week_view(
        query.year,
        query.month,
        query.day,
    )?))
}

#[derive(Debug)]
struct ApiError(ServiceError);

impl From<ServiceError> for ApiError {
    fn from(value: ServiceError) -> Self {
        Self(value)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let status = match &self.0 {
            ServiceError::NotFound => StatusCode::NOT_FOUND,
            ServiceError::Repo(crate::repo::RepoError::NotFound) => StatusCode::NOT_FOUND,
            ServiceError::Schedule(_) => StatusCode::BAD_REQUEST,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };

        let body = Json(serde_json::json!({
            "error": self.0.to_string(),
        }));

        (status, body).into_response()
    }
}
