use unified_gateway::{router, AppState, Config};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    let state = AppState::new(&config)?;
    let address = std::env::var("UNIFIED_LISTEN").unwrap_or_else(|_| "127.0.0.1:3030".into());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    eprintln!(
        "unified gateway listening on {address}; upstream enabled: {}",
        config.allow_upstream
    );
    axum::serve(listener, router(state, &config.web_dir)).await?;
    Ok(())
}
