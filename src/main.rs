use std::{net::SocketAddr, sync::Arc};

use scischedule::{repo::SledRepo, service::AppService, web};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let repo = Arc::new(SledRepo::open("./data")?);
    let service = Arc::new(AppService::new(repo));
    let app = web::router(service);

    let addr = SocketAddr::from(([0, 0, 0, 0], 3000));
    tracing::info!(%addr, "starting server");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
