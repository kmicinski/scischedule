use std::sync::Arc;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use chrono::{Datelike, NaiveDate, Utc};
use http_body_util::BodyExt;
use scischedule::{repo::SledRepo, service::AppService, web};
use tower::ServiceExt;

fn tmp_path() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("scischedule-api-test-{}", uuid::Uuid::new_v4()))
}

fn app() -> axum::Router {
    let repo = Arc::new(SledRepo::open(tmp_path()).unwrap());
    let svc = Arc::new(AppService::new(repo));
    web::router(svc)
}

#[tokio::test]
async fn health_index_renders() {
    let app = app();
    let res = app
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn create_protocol_then_list_protocols() {
    let app = app();

    let create_body = serde_json::json!({
      "name": "Protocol A",
      "description": "A desc",
      "steps": [
        {"name":"Seed", "details":"x", "parent_step_index": null, "default_offset_days": 0},
        {"name":"Treat", "details":"y", "parent_step_index": 0, "default_offset_days": 3}
      ]
    });

    let create = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/protocols")
                .header("content-type", "application/json")
                .body(Body::from(create_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(create.status(), StatusCode::OK);

    let list = app
        .oneshot(
            Request::builder()
                .uri("/api/protocols")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(list.status(), StatusCode::OK);
    let bytes = list.into_body().collect().await.unwrap().to_bytes();
    let protocols: Vec<serde_json::Value> = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(protocols.len(), 1);
}

#[tokio::test]
async fn update_protocol_via_patch() {
    let app = app();

    let create_body = serde_json::json!({
      "name": "Protocol Edit",
      "description": "Initial",
      "steps": [
        {"name":"Seed", "details":"x", "parent_step_index": null, "default_offset_days": 0},
        {"name":"Treat", "details":"y", "parent_step_index": 0, "default_offset_days": 3}
      ]
    });

    let create = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/protocols")
                .header("content-type", "application/json")
                .body(Body::from(create_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(create.status(), StatusCode::OK);
    let create_bytes = create.into_body().collect().await.unwrap().to_bytes();
    let protocol: serde_json::Value = serde_json::from_slice(&create_bytes).unwrap();

    let update_body = serde_json::json!({
      "name": "Protocol Edit Updated",
      "description": "Changed",
      "steps": [
        {"name":"Seed updated", "details":"x2", "parent_step_index": null, "default_offset_days": 1},
        {"name":"Treat updated", "details":"y2", "parent_step_index": 0, "default_offset_days": 4}
      ]
    });

    let update = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/protocols/{}", protocol["id"].as_str().unwrap()))
                .header("content-type", "application/json")
                .body(Body::from(update_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(update.status(), StatusCode::OK);
    let update_bytes = update.into_body().collect().await.unwrap().to_bytes();
    let updated: serde_json::Value = serde_json::from_slice(&update_bytes).unwrap();
    assert_eq!(updated["name"], "Protocol Edit Updated");
    assert_eq!(updated["steps"][1]["default_offset_days"], 4);
}

#[tokio::test]
async fn plan_lock_and_move_flow() {
    let app = app();

    let create_body = serde_json::json!({
      "name": "Protocol B",
      "description": "B desc",
      "steps": [
        {"name":"Step1", "details":"x", "parent_step_index": null, "default_offset_days": 0},
        {"name":"Step2", "details":"y", "parent_step_index": 0, "default_offset_days": 3}
      ]
    });

    let create = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/protocols")
                .header("content-type", "application/json")
                .body(Body::from(create_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let create_bytes = create.into_body().collect().await.unwrap().to_bytes();
    let protocol: serde_json::Value = serde_json::from_slice(&create_bytes).unwrap();

    let plan_body = serde_json::json!({
      "protocol_id": protocol["id"],
      "start_date": "2026-02-05",
      "created_by": "alice"
    });

    let plan = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/experiments")
                .header("content-type", "application/json")
                .body(Body::from(plan_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(plan.status(), StatusCode::OK);
    let plan_bytes = plan.into_body().collect().await.unwrap().to_bytes();
    let exp: serde_json::Value = serde_json::from_slice(&plan_bytes).unwrap();

    let lock = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/experiments/{}/lock",
                    exp["id"].as_str().unwrap()
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(lock.status(), StatusCode::OK);

    let move_body = serde_json::json!({
      "task_id": exp["tasks"][0]["id"],
      "new_date": "2026-02-06",
      "reason": "move"
    });

    let moved = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!(
                    "/api/experiments/{}/tasks/move",
                    exp["id"].as_str().unwrap()
                ))
                .header("content-type", "application/json")
                .body(Body::from(move_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(moved.status(), StatusCode::OK);
}

#[tokio::test]
async fn month_and_week_views_work() {
    let app = app();

    let now = Utc::now().date_naive();
    let month = now.month();
    let year = now.year();

    let month_res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/views/month?year={year}&month={month}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(month_res.status(), StatusCode::OK);

    let week_res = app
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/views/week?year={}&month={}&day={}",
                    year,
                    month,
                    now.day()
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(week_res.status(), StatusCode::OK);
}

#[tokio::test]
async fn move_rejects_invalid_dates() {
    let app = app();

    let create_body = serde_json::json!({
      "name": "Protocol C",
      "description": "C desc",
      "steps": [
        {"name":"Step1", "details":"x", "parent_step_index": null, "default_offset_days": 0},
        {"name":"Step2", "details":"y", "parent_step_index": 0, "default_offset_days": 0}
      ]
    });

    let create = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/protocols")
                .header("content-type", "application/json")
                .body(Body::from(create_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    let create_bytes = create.into_body().collect().await.unwrap().to_bytes();
    let protocol: serde_json::Value = serde_json::from_slice(&create_bytes).unwrap();

    let plan_body = serde_json::json!({
      "protocol_id": protocol["id"],
      "start_date": NaiveDate::from_ymd_opt(2026, 2, 5).unwrap(),
      "created_by": "alice"
    });

    let plan = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/experiments")
                .header("content-type", "application/json")
                .body(Body::from(plan_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    let plan_bytes = plan.into_body().collect().await.unwrap().to_bytes();
    let exp: serde_json::Value = serde_json::from_slice(&plan_bytes).unwrap();

    let move_body = serde_json::json!({
      "task_id": uuid::Uuid::new_v4(),
      "new_date": "2026-02-06",
      "reason": "bad"
    });

    let moved = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!(
                    "/api/experiments/{}/tasks/move",
                    exp["id"].as_str().unwrap()
                ))
                .header("content-type", "application/json")
                .body(Body::from(move_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(moved.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn move_rejects_skipping_prerequisites() {
    let app = app();

    let create_body = serde_json::json!({
      "name": "Protocol D",
      "description": "D desc",
      "steps": [
        {"name":"Step1", "details":"x", "parent_step_index": null, "default_offset_days": 0},
        {"name":"Step2", "details":"y", "parent_step_index": 0, "default_offset_days": 3},
        {"name":"Step3", "details":"z", "parent_step_index": 1, "default_offset_days": 2}
      ]
    });

    let create = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/protocols")
                .header("content-type", "application/json")
                .body(Body::from(create_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    let create_bytes = create.into_body().collect().await.unwrap().to_bytes();
    let protocol: serde_json::Value = serde_json::from_slice(&create_bytes).unwrap();

    let plan_body = serde_json::json!({
      "protocol_id": protocol["id"],
      "start_date": "2026-02-05",
      "created_by": "alice"
    });

    let plan = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/experiments")
                .header("content-type", "application/json")
                .body(Body::from(plan_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    let plan_bytes = plan.into_body().collect().await.unwrap().to_bytes();
    let exp: serde_json::Value = serde_json::from_slice(&plan_bytes).unwrap();

    let move_body = serde_json::json!({
      "task_id": exp["tasks"][2]["id"],
      "new_date": "2026-02-07",
      "reason": "bad order"
    });

    let moved = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!(
                    "/api/experiments/{}/tasks/move",
                    exp["id"].as_str().unwrap()
                ))
                .header("content-type", "application/json")
                .body(Body::from(move_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(moved.status(), StatusCode::BAD_REQUEST);
}
