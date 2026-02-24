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

fn authed(builder: axum::http::request::Builder) -> axum::http::request::Builder {
    builder.header("Remote-User", "alice")
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
async fn missing_remote_user_returns_401() {
    let app = app();
    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/protocols")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn me_endpoint_returns_username() {
    let app = app();
    let res = app
        .oneshot(
            authed(Request::builder().uri("/api/me"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["username"], "alice");
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
            authed(
                Request::builder()
                    .method("POST")
                    .uri("/api/protocols")
                    .header("content-type", "application/json"),
            )
            .body(Body::from(create_body.to_string()))
            .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(create.status(), StatusCode::OK);
    let create_bytes = create.into_body().collect().await.unwrap().to_bytes();
    let protocol: serde_json::Value = serde_json::from_slice(&create_bytes).unwrap();
    assert_eq!(protocol["created_by"], "alice");

    let list = app
        .oneshot(
            authed(Request::builder().uri("/api/protocols"))
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
            authed(
                Request::builder()
                    .method("POST")
                    .uri("/api/protocols")
                    .header("content-type", "application/json"),
            )
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
            authed(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/protocols/{}", protocol["id"].as_str().unwrap()))
                    .header("content-type", "application/json"),
            )
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
            authed(
                Request::builder()
                    .method("POST")
                    .uri("/api/protocols")
                    .header("content-type", "application/json"),
            )
            .body(Body::from(create_body.to_string()))
            .unwrap(),
        )
        .await
        .unwrap();
    let create_bytes = create.into_body().collect().await.unwrap().to_bytes();
    let protocol: serde_json::Value = serde_json::from_slice(&create_bytes).unwrap();

    let plan_body = serde_json::json!({
      "protocol_id": protocol["id"],
      "start_date": "2026-02-05"
    });

    let plan = app
        .clone()
        .oneshot(
            authed(
                Request::builder()
                    .method("POST")
                    .uri("/api/experiments")
                    .header("content-type", "application/json"),
            )
            .body(Body::from(plan_body.to_string()))
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(plan.status(), StatusCode::OK);
    let plan_bytes = plan.into_body().collect().await.unwrap().to_bytes();
    let exp: serde_json::Value = serde_json::from_slice(&plan_bytes).unwrap();
    assert_eq!(exp["created_by"], "alice");

    let lock = app
        .clone()
        .oneshot(
            authed(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/api/experiments/{}/lock",
                        exp["id"].as_str().unwrap()
                    )),
            )
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
            authed(
                Request::builder()
                    .method("PATCH")
                    .uri(format!(
                        "/api/experiments/{}/tasks/move",
                        exp["id"].as_str().unwrap()
                    ))
                    .header("content-type", "application/json"),
            )
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
            authed(
                Request::builder()
                    .uri(format!("/api/views/month?year={year}&month={month}")),
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(month_res.status(), StatusCode::OK);

    let week_res = app
        .oneshot(
            authed(Request::builder().uri(format!(
                "/api/views/week?year={}&month={}&day={}",
                year,
                month,
                now.day()
            )))
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
            authed(
                Request::builder()
                    .method("POST")
                    .uri("/api/protocols")
                    .header("content-type", "application/json"),
            )
            .body(Body::from(create_body.to_string()))
            .unwrap(),
        )
        .await
        .unwrap();

    let create_bytes = create.into_body().collect().await.unwrap().to_bytes();
    let protocol: serde_json::Value = serde_json::from_slice(&create_bytes).unwrap();

    let plan_body = serde_json::json!({
      "protocol_id": protocol["id"],
      "start_date": NaiveDate::from_ymd_opt(2026, 2, 5).unwrap()
    });

    let plan = app
        .clone()
        .oneshot(
            authed(
                Request::builder()
                    .method("POST")
                    .uri("/api/experiments")
                    .header("content-type", "application/json"),
            )
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
            authed(
                Request::builder()
                    .method("PATCH")
                    .uri(format!(
                        "/api/experiments/{}/tasks/move",
                        exp["id"].as_str().unwrap()
                    ))
                    .header("content-type", "application/json"),
            )
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
            authed(
                Request::builder()
                    .method("POST")
                    .uri("/api/protocols")
                    .header("content-type", "application/json"),
            )
            .body(Body::from(create_body.to_string()))
            .unwrap(),
        )
        .await
        .unwrap();

    let create_bytes = create.into_body().collect().await.unwrap().to_bytes();
    let protocol: serde_json::Value = serde_json::from_slice(&create_bytes).unwrap();

    let plan_body = serde_json::json!({
      "protocol_id": protocol["id"],
      "start_date": "2026-02-05"
    });

    let plan = app
        .clone()
        .oneshot(
            authed(
                Request::builder()
                    .method("POST")
                    .uri("/api/experiments")
                    .header("content-type", "application/json"),
            )
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
            authed(
                Request::builder()
                    .method("PATCH")
                    .uri(format!(
                        "/api/experiments/{}/tasks/move",
                        exp["id"].as_str().unwrap()
                    ))
                    .header("content-type", "application/json"),
            )
            .body(Body::from(move_body.to_string()))
            .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(moved.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn user_cannot_see_other_users_experiments() {
    let app = app();

    // Alice creates a protocol and experiment
    let create_body = serde_json::json!({
      "name": "Protocol E",
      "description": "E desc",
      "steps": [
        {"name":"Step1", "details":"x", "parent_step_index": null, "default_offset_days": 0}
      ]
    });

    app.clone()
        .oneshot(
            authed(
                Request::builder()
                    .method("POST")
                    .uri("/api/protocols")
                    .header("content-type", "application/json"),
            )
            .body(Body::from(create_body.to_string()))
            .unwrap(),
        )
        .await
        .unwrap();

    let list = app
        .clone()
        .oneshot(
            authed(Request::builder().uri("/api/protocols"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = list.into_body().collect().await.unwrap().to_bytes();
    let protocols: Vec<serde_json::Value> = serde_json::from_slice(&bytes).unwrap();
    let protocol_id = protocols[0]["id"].as_str().unwrap();

    let plan_body = serde_json::json!({
      "protocol_id": protocol_id,
      "start_date": "2026-02-05"
    });

    app.clone()
        .oneshot(
            authed(
                Request::builder()
                    .method("POST")
                    .uri("/api/experiments")
                    .header("content-type", "application/json"),
            )
            .body(Body::from(plan_body.to_string()))
            .unwrap(),
        )
        .await
        .unwrap();

    // Alice can see the experiment
    let alice_list = app
        .clone()
        .oneshot(
            authed(Request::builder().uri("/api/experiments"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = alice_list.into_body().collect().await.unwrap().to_bytes();
    let alice_experiments: Vec<serde_json::Value> = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(alice_experiments.len(), 1);

    // Bob cannot see Alice's experiment
    let bob_list = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/experiments")
                .header("Remote-User", "bob")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = bob_list.into_body().collect().await.unwrap().to_bytes();
    let bob_experiments: Vec<serde_json::Value> = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(bob_experiments.len(), 0);

    // Both can see the protocol (shared-readable)
    let bob_protocols = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/protocols")
                .header("Remote-User", "bob")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = bob_protocols.into_body().collect().await.unwrap().to_bytes();
    let bob_protos: Vec<serde_json::Value> = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(bob_protos.len(), 1);
}

#[tokio::test]
async fn user_cannot_lock_other_users_experiment() {
    let app = app();

    let create_body = serde_json::json!({
      "name": "Protocol F",
      "description": "F desc",
      "steps": [
        {"name":"Step1", "details":"x", "parent_step_index": null, "default_offset_days": 0}
      ]
    });

    app.clone()
        .oneshot(
            authed(
                Request::builder()
                    .method("POST")
                    .uri("/api/protocols")
                    .header("content-type", "application/json"),
            )
            .body(Body::from(create_body.to_string()))
            .unwrap(),
        )
        .await
        .unwrap();

    let list = app
        .clone()
        .oneshot(
            authed(Request::builder().uri("/api/protocols"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = list.into_body().collect().await.unwrap().to_bytes();
    let protocols: Vec<serde_json::Value> = serde_json::from_slice(&bytes).unwrap();

    let plan_body = serde_json::json!({
      "protocol_id": protocols[0]["id"],
      "start_date": "2026-02-05"
    });

    let plan = app
        .clone()
        .oneshot(
            authed(
                Request::builder()
                    .method("POST")
                    .uri("/api/experiments")
                    .header("content-type", "application/json"),
            )
            .body(Body::from(plan_body.to_string()))
            .unwrap(),
        )
        .await
        .unwrap();
    let plan_bytes = plan.into_body().collect().await.unwrap().to_bytes();
    let exp: serde_json::Value = serde_json::from_slice(&plan_bytes).unwrap();

    // Bob tries to lock Alice's experiment
    let lock = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/experiments/{}/lock",
                    exp["id"].as_str().unwrap()
                ))
                .header("Remote-User", "bob")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(lock.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn create_and_list_standalone_tasks() {
    let app = app();

    let create_body = serde_json::json!({
        "title": "Pick up reagents",
        "date": "2026-03-10"
    });

    let create = app
        .clone()
        .oneshot(
            authed(
                Request::builder()
                    .method("POST")
                    .uri("/api/tasks")
                    .header("content-type", "application/json"),
            )
            .body(Body::from(create_body.to_string()))
            .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(create.status(), StatusCode::OK);
    let create_bytes = create.into_body().collect().await.unwrap().to_bytes();
    let task: serde_json::Value = serde_json::from_slice(&create_bytes).unwrap();
    assert_eq!(task["title"], "Pick up reagents");
    assert_eq!(task["date"], "2026-03-10");
    assert_eq!(task["completed"], false);
    assert_eq!(task["created_by"], "alice");

    let list = app
        .oneshot(
            authed(Request::builder().uri("/api/tasks"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(list.status(), StatusCode::OK);
    let bytes = list.into_body().collect().await.unwrap().to_bytes();
    let tasks: Vec<serde_json::Value> = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0]["title"], "Pick up reagents");
}

#[tokio::test]
async fn update_standalone_task() {
    let app = app();

    let create_body = serde_json::json!({
        "title": "Lab meeting",
        "date": "2026-03-12"
    });

    let create = app
        .clone()
        .oneshot(
            authed(
                Request::builder()
                    .method("POST")
                    .uri("/api/tasks")
                    .header("content-type", "application/json"),
            )
            .body(Body::from(create_body.to_string()))
            .unwrap(),
        )
        .await
        .unwrap();

    let create_bytes = create.into_body().collect().await.unwrap().to_bytes();
    let task: serde_json::Value = serde_json::from_slice(&create_bytes).unwrap();
    let task_id = task["id"].as_str().unwrap();

    let update_body = serde_json::json!({
        "title": "Lab meeting (moved)",
        "completed": true
    });

    let update = app
        .clone()
        .oneshot(
            authed(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/tasks/{task_id}"))
                    .header("content-type", "application/json"),
            )
            .body(Body::from(update_body.to_string()))
            .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(update.status(), StatusCode::OK);
    let bytes = update.into_body().collect().await.unwrap().to_bytes();
    let updated: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(updated["title"], "Lab meeting (moved)");
    assert_eq!(updated["completed"], true);
}

#[tokio::test]
async fn delete_standalone_task() {
    let app = app();

    let create_body = serde_json::json!({
        "title": "Dispose waste",
        "date": "2026-03-15"
    });

    let create = app
        .clone()
        .oneshot(
            authed(
                Request::builder()
                    .method("POST")
                    .uri("/api/tasks")
                    .header("content-type", "application/json"),
            )
            .body(Body::from(create_body.to_string()))
            .unwrap(),
        )
        .await
        .unwrap();

    let create_bytes = create.into_body().collect().await.unwrap().to_bytes();
    let task: serde_json::Value = serde_json::from_slice(&create_bytes).unwrap();
    let task_id = task["id"].as_str().unwrap();

    let delete = app
        .clone()
        .oneshot(
            authed(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/tasks/{task_id}")),
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(delete.status(), StatusCode::NO_CONTENT);

    let list = app
        .oneshot(
            authed(Request::builder().uri("/api/tasks"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let bytes = list.into_body().collect().await.unwrap().to_bytes();
    let tasks: Vec<serde_json::Value> = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(tasks.len(), 0);
}

#[tokio::test]
async fn standalone_task_user_isolation() {
    let app = app();

    // Alice creates a task
    let create_body = serde_json::json!({
        "title": "Alice's task",
        "date": "2026-03-20"
    });

    let create = app
        .clone()
        .oneshot(
            authed(
                Request::builder()
                    .method("POST")
                    .uri("/api/tasks")
                    .header("content-type", "application/json"),
            )
            .body(Body::from(create_body.to_string()))
            .unwrap(),
        )
        .await
        .unwrap();

    let create_bytes = create.into_body().collect().await.unwrap().to_bytes();
    let task: serde_json::Value = serde_json::from_slice(&create_bytes).unwrap();
    let task_id = task["id"].as_str().unwrap();

    // Bob can't see Alice's task
    let bob_list = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/tasks")
                .header("Remote-User", "bob")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let bytes = bob_list.into_body().collect().await.unwrap().to_bytes();
    let bob_tasks: Vec<serde_json::Value> = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(bob_tasks.len(), 0);

    // Bob can't modify Alice's task
    let bob_update = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/tasks/{task_id}"))
                .header("Remote-User", "bob")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"title": "hacked"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(bob_update.status(), StatusCode::FORBIDDEN);

    // Bob can't delete Alice's task
    let bob_delete = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/tasks/{task_id}"))
                .header("Remote-User", "bob")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(bob_delete.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn standalone_task_missing_auth() {
    let app = app();

    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/tasks")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn delete_experiment() {
    let app = app();

    // Create a protocol
    let proto_body = serde_json::json!({
        "name": "Proto",
        "description": "D",
        "steps": [
            {"name":"S1", "details":"x", "parent_step_indexes": [], "default_offset_days": 0}
        ]
    });

    let create = app
        .clone()
        .oneshot(
            authed(
                Request::builder()
                    .method("POST")
                    .uri("/api/protocols")
                    .header("content-type", "application/json"),
            )
            .body(Body::from(proto_body.to_string()))
            .unwrap(),
        )
        .await
        .unwrap();
    let bytes = create.into_body().collect().await.unwrap().to_bytes();
    let protocol: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

    // Plan an experiment
    let plan_body = serde_json::json!({
        "protocol_id": protocol["id"],
        "start_date": "2026-03-01"
    });

    let plan = app
        .clone()
        .oneshot(
            authed(
                Request::builder()
                    .method("POST")
                    .uri("/api/experiments")
                    .header("content-type", "application/json"),
            )
            .body(Body::from(plan_body.to_string()))
            .unwrap(),
        )
        .await
        .unwrap();
    let bytes = plan.into_body().collect().await.unwrap().to_bytes();
    let exp: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let exp_id = exp["id"].as_str().unwrap();

    // Delete the experiment
    let delete = app
        .clone()
        .oneshot(
            authed(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/experiments/{exp_id}")),
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(delete.status(), StatusCode::NO_CONTENT);

    // Verify it's gone
    let list = app
        .oneshot(
            authed(Request::builder().uri("/api/experiments"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = list.into_body().collect().await.unwrap().to_bytes();
    let experiments: Vec<serde_json::Value> = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(experiments.len(), 0);
}

#[tokio::test]
async fn delete_experiment_forbidden_for_other_user() {
    let app = app();

    // Alice creates protocol + experiment
    let proto_body = serde_json::json!({
        "name": "Proto",
        "description": "D",
        "steps": [
            {"name":"S1", "details":"x", "parent_step_indexes": [], "default_offset_days": 0}
        ]
    });

    let create = app
        .clone()
        .oneshot(
            authed(
                Request::builder()
                    .method("POST")
                    .uri("/api/protocols")
                    .header("content-type", "application/json"),
            )
            .body(Body::from(proto_body.to_string()))
            .unwrap(),
        )
        .await
        .unwrap();
    let bytes = create.into_body().collect().await.unwrap().to_bytes();
    let protocol: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

    let plan_body = serde_json::json!({
        "protocol_id": protocol["id"],
        "start_date": "2026-03-01"
    });

    let plan = app
        .clone()
        .oneshot(
            authed(
                Request::builder()
                    .method("POST")
                    .uri("/api/experiments")
                    .header("content-type", "application/json"),
            )
            .body(Body::from(plan_body.to_string()))
            .unwrap(),
        )
        .await
        .unwrap();
    let bytes = plan.into_body().collect().await.unwrap().to_bytes();
    let exp: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let exp_id = exp["id"].as_str().unwrap();

    // Bob can't delete Alice's experiment
    let bob_delete = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/experiments/{exp_id}"))
                .header("Remote-User", "bob")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(bob_delete.status(), StatusCode::FORBIDDEN);
}
