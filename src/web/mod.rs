use std::sync::Arc;

use axum::{
    async_trait,
    extract::{FromRequestParts, Path, Query, State},
    http::{request::Parts, StatusCode},
    response::{Html, IntoResponse},
    routing::{delete, get, patch, post},
    Json, Router,
};
use serde::Deserialize;
use tower_http::{cors::CorsLayer, services::ServeDir, trace::TraceLayer};
use uuid::Uuid;

use crate::{
    domain::{
        CreateProtocolRequest, CreateStandaloneTaskRequest, MoveTaskRequest,
        PlanExperimentRequest, ReorderTaskRequest, UpdateStandaloneTaskRequest,
    },
    repo::SledRepo,
    service::{AppService, ServiceError},
};

pub type AppState = Arc<AppService<SledRepo>>;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/api/me", get(me))
        .route("/api/protocols", get(list_protocols).post(create_protocol))
        .route("/api/protocols/:id", get(get_protocol).patch(update_protocol).delete(delete_protocol_handler))
        .route(
            "/api/experiments",
            get(list_experiments).post(plan_experiment),
        )
        .route(
            "/api/experiments/:id",
            delete(delete_experiment_handler),
        )
        .route("/api/experiments/:id/lock", post(lock_experiment))
        .route("/api/experiments/:id/tasks/move", patch(move_task))
        .route("/api/experiments/:id/tasks/reorder", patch(reorder_task))
        .route(
            "/api/tasks",
            get(list_standalone_tasks).post(create_standalone_task),
        )
        .route(
            "/api/tasks/:id",
            patch(update_standalone_task).delete(delete_standalone_task),
        )
        .route("/api/views/month", get(month_view))
        .route("/api/views/week", get(week_view))
        .nest_service("/static", ServeDir::new("static"))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// Authenticated user extracted from the `Remote-User` header set by Authelia.
pub struct AuthUser {
    pub username: String,
}

#[async_trait]
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _state: &AppState) -> Result<Self, Self::Rejection> {
        let username = parts
            .headers
            .get("Remote-User")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
            .ok_or(ApiError(ServiceError::Unauthorized))?;

        Ok(AuthUser { username })
    }
}

async fn index() -> impl IntoResponse {
    Html(include_str!("../../static/index.html"))
}

async fn me(user: AuthUser) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "username": user.username,
        "display_name": user.username,
    }))
}

async fn create_protocol(
    State(service): State<AppState>,
    user: AuthUser,
    Json(req): Json<CreateProtocolRequest>,
) -> Result<Json<crate::domain::Protocol>, ApiError> {
    Ok(Json(service.create_protocol(req, &user.username)?))
}

async fn list_protocols(
    State(service): State<AppState>,
    _user: AuthUser,
) -> Result<Json<Vec<crate::domain::Protocol>>, ApiError> {
    Ok(Json(service.list_protocols()?))
}

async fn get_protocol(
    State(service): State<AppState>,
    _user: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<crate::domain::Protocol>, ApiError> {
    Ok(Json(service.get_protocol(id)?))
}

async fn update_protocol(
    State(service): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(req): Json<CreateProtocolRequest>,
) -> Result<Json<crate::domain::Protocol>, ApiError> {
    Ok(Json(service.update_protocol(id, req, &user.username)?))
}

async fn delete_protocol_handler(
    State(service): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    service.delete_protocol(id, &user.username)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn plan_experiment(
    State(service): State<AppState>,
    user: AuthUser,
    Json(req): Json<PlanExperimentRequest>,
) -> Result<Json<crate::domain::Experiment>, ApiError> {
    Ok(Json(service.plan_experiment(req, &user.username)?))
}

async fn list_experiments(
    State(service): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<crate::domain::Experiment>>, ApiError> {
    Ok(Json(service.list_experiments(&user.username)?))
}

async fn lock_experiment(
    State(service): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<Json<crate::domain::Experiment>, ApiError> {
    Ok(Json(service.lock_experiment(id, &user.username)?))
}

async fn delete_experiment_handler(
    State(service): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    service.delete_experiment(id, &user.username)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn move_task(
    State(service): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(req): Json<MoveTaskRequest>,
) -> Result<Json<crate::domain::Experiment>, ApiError> {
    Ok(Json(service.move_task(id, req, &user.username)?))
}

async fn reorder_task(
    State(service): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(req): Json<ReorderTaskRequest>,
) -> Result<Json<crate::domain::Experiment>, ApiError> {
    Ok(Json(service.reorder_task(id, req, &user.username)?))
}

async fn create_standalone_task(
    State(service): State<AppState>,
    user: AuthUser,
    Json(req): Json<CreateStandaloneTaskRequest>,
) -> Result<Json<crate::domain::StandaloneTask>, ApiError> {
    Ok(Json(service.create_standalone_task(req, &user.username)?))
}

async fn list_standalone_tasks(
    State(service): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<crate::domain::StandaloneTask>>, ApiError> {
    Ok(Json(service.list_standalone_tasks(&user.username)?))
}

async fn update_standalone_task(
    State(service): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(req): Json<UpdateStandaloneTaskRequest>,
) -> Result<Json<crate::domain::StandaloneTask>, ApiError> {
    Ok(Json(
        service.update_standalone_task(id, req, &user.username)?,
    ))
}

async fn delete_standalone_task(
    State(service): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    service.delete_standalone_task(id, &user.username)?;
    Ok(StatusCode::NO_CONTENT)
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
    user: AuthUser,
    Query(query): Query<MonthQuery>,
) -> Result<Json<crate::domain::MonthView>, ApiError> {
    Ok(Json(
        service.month_view(query.year, query.month, &user.username)?,
    ))
}

async fn week_view(
    State(service): State<AppState>,
    user: AuthUser,
    Query(query): Query<WeekQuery>,
) -> Result<Json<crate::domain::WeekView>, ApiError> {
    Ok(Json(service.week_view(
        query.year,
        query.month,
        query.day,
        &user.username,
    )?))
}

#[derive(Debug)]
pub struct ApiError(ServiceError);

impl From<ServiceError> for ApiError {
    fn from(value: ServiceError) -> Self {
        Self(value)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let status = match &self.0 {
            ServiceError::Unauthorized => StatusCode::UNAUTHORIZED,
            ServiceError::Forbidden => StatusCode::FORBIDDEN,
            ServiceError::NotFound => StatusCode::NOT_FOUND,
            ServiceError::Repo(crate::repo::RepoError::NotFound) => StatusCode::NOT_FOUND,
            ServiceError::Schedule(_) => StatusCode::BAD_REQUEST,
            ServiceError::InvalidProtocolEdit(_) => StatusCode::BAD_REQUEST,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };

        let body = Json(serde_json::json!({
            "error": self.0.to_string(),
        }));

        (status, body).into_response()
    }
}
