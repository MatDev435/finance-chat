//! Whisper models (ggml files of whisper.cpp), downloaded once from the official
//! whisper.cpp repository on Hugging Face into the app data directory.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

use crate::settings::MODELS;
use crate::windows;

/// Anything smaller is certainly not a model (an error page, a truncated file).
const MIN_MODEL_BYTES: u64 = 30 * 1024 * 1024;

static DOWNLOADING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub name: String,
    pub label: String,
    pub size: String,
    pub downloaded: bool,
}

fn describe(name: &str) -> (&'static str, &'static str) {
    match name {
        "base" => ("Básico (mais rápido)", "cerca de 150 MB"),
        _ => ("Pequeno (mais preciso, recomendado)", "cerca de 490 MB"),
    }
}

pub fn models_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("models"))
}

/// Path of a known model (None for any other name: names never reach the file system unchecked).
pub fn path(app: &AppHandle, name: &str) -> Option<PathBuf> {
    if !MODELS.contains(&name) {
        return None;
    }
    models_dir(app).map(|dir| dir.join(format!("ggml-{name}.bin")))
}

pub fn exists(app: &AppHandle, name: &str) -> bool {
    path(app, name).and_then(|path| std::fs::metadata(path).ok()).map(|meta| meta.is_file() && meta.len() >= MIN_MODEL_BYTES).unwrap_or(false)
}

pub fn list(app: &AppHandle) -> Vec<ModelInfo> {
    MODELS
        .iter()
        .map(|name| {
            let (label, size) = describe(name);
            ModelInfo { name: (*name).into(), label: label.into(), size: size.into(), downloaded: exists(app, name) }
        })
        .collect()
}

pub fn url(name: &str) -> String {
    format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{name}.bin")
}

/// Downloads a model to a ".part" file and renames it only when complete;
/// progress goes to the settings window ("voice://download").
pub async fn download(app: &AppHandle, name: &str) -> Result<(), String> {
    let target = path(app, name).ok_or("Modelo desconhecido.")?;
    if DOWNLOADING.swap(true, Ordering::SeqCst) {
        return Err("Já há um modelo sendo baixado.".into());
    }
    let result = fetch(app, name, &target).await;
    DOWNLOADING.store(false, Ordering::SeqCst);
    result
}

async fn fetch(app: &AppHandle, name: &str, target: &PathBuf) -> Result<(), String> {
    let dir = target.parent().ok_or("Pasta de modelos indisponível.")?;
    tokio::fs::create_dir_all(dir).await.map_err(|error| format!("Não foi possível criar a pasta de modelos: {error}"))?;
    let partial = target.with_extension("bin.part");
    let failed = |message: String| {
        let partial = partial.clone();
        async move {
            let _ = tokio::fs::remove_file(&partial).await;
            Err::<(), String>(message)
        }
    };

    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).build().map_err(|error| error.to_string())?;
    let response = match client.get(url(name)).send().await.and_then(|response| response.error_for_status()) {
        Ok(response) => response,
        Err(_) => return failed("Não foi possível baixar o modelo. Verifique a sua conexão e tente de novo.".into()).await,
    };
    let total = response.content_length();
    let mut file = tokio::fs::File::create(&partial).await.map_err(|error| format!("Não foi possível gravar o modelo: {error}"))?;
    let mut received: u64 = 0;
    let mut last_report = Instant::now();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) => return failed("O download do modelo foi interrompido. Tente de novo.".into()).await,
        };
        if let Err(error) = file.write_all(&chunk).await {
            return failed(format!("Não foi possível gravar o modelo: {error}")).await;
        }
        received += chunk.len() as u64;
        if last_report.elapsed() >= Duration::from_millis(250) {
            last_report = Instant::now();
            let _ = app.emit_to(windows::SETTINGS, "voice://download", json!({ "model": name, "received": received, "total": total }));
        }
    }
    if file.flush().await.is_err() {
        return failed("Não foi possível gravar o modelo.".into()).await;
    }
    drop(file);
    if total.map(|total| total != received).unwrap_or(false) || received < MIN_MODEL_BYTES {
        return failed("O modelo baixado está incompleto. Tente de novo.".into()).await;
    }
    tokio::fs::rename(&partial, target).await.map_err(|error| format!("Não foi possível salvar o modelo: {error}"))?;
    let _ = app.emit_to(windows::SETTINGS, "voice://download", json!({ "model": name, "received": received, "total": total }));
    Ok(())
}

pub fn delete(app: &AppHandle, name: &str) -> Result<(), String> {
    let target = path(app, name).ok_or("Modelo desconhecido.")?;
    match std::fs::remove_file(target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Não foi possível apagar o modelo: {error}")),
    }
}
