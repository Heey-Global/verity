#![recursion_limit = "512"]

use std::{
    collections::HashMap,
    env,
    io::{Cursor, Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chrono::{DateTime, Utc};
use matrix_sdk::{
    Client, LoopCtrl, Room,
    authentication::matrix::MatrixSession,
    config::SyncSettings,
    ruma::events::room::{
        MediaSource,
        message::{MessageType, OriginalSyncRoomMessageEvent, Relation},
        redaction::OriginalSyncRoomRedactionEvent,
    },
};
use matrix_sdk_crypto::AttachmentDecryptor;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{fs, sync::RwLock, time::sleep};
use tracing::{error, info, warn};

const MAX_ATTACHMENT_BYTES: usize = 50 * 1024 * 1024;

#[derive(Clone)]
struct Config {
    store_passphrase: String,
    verity_url: String,
    connector_token: String,
    verity_ca_cert_path: Option<PathBuf>,
    data_dir: PathBuf,
}

impl Config {
    fn from_env() -> Result<Self> {
        fn required(name: &str) -> Result<String> {
            env::var(name).with_context(|| format!("{name} is required"))
        }
        fn secret(name: &str) -> Result<String> {
            let file_name = format!("{name}_FILE");
            match (env::var(name).ok(), env::var(&file_name).ok()) {
                (Some(_), Some(_)) => bail!("set either {name} or {file_name}, not both"),
                (Some(value), None) => Ok(value),
                (None, Some(path)) => std::fs::read_to_string(&path)
                    .with_context(|| format!("could not read {file_name}"))
                    .map(|value| {
                        value
                            .trim_end_matches(|c| c == '\r' || c == '\n')
                            .to_owned()
                    }),
                (None, None) => bail!("{name} or {file_name} is required"),
            }
        }
        let config = Self {
            store_passphrase: secret("MATRIX_STORE_PASSPHRASE")?,
            verity_url: required("VERITY_INTERNAL_URL")?,
            connector_token: secret("VERITY_MATRIX_CONNECTOR_TOKEN")?,
            verity_ca_cert_path: env::var("VERITY_CA_CERT_PATH").ok().map(PathBuf::from),
            data_dir: PathBuf::from(required("MATRIX_DATA_DIR")?),
        };
        if config.connector_token.len() < 32 || config.store_passphrase.len() < 32 {
            bail!(
                "Matrix requires a connector token and store passphrase of at least 32 characters"
            );
        }
        Ok(config)
    }
}

#[derive(Clone)]
struct Api {
    client: reqwest::Client,
    base: String,
    token: String,
    account_id: String,
}

#[derive(Deserialize)]
struct MatrixConfigResponse {
    config: Option<MatrixCredentials>,
}

#[derive(Clone, Deserialize)]
struct MatrixCredentials {
    endpoint: String,
    username: String,
    password: String,
}

#[derive(Deserialize)]
struct BindingResponse {
    sources: Vec<Binding>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Binding {
    source_id: String,
    status: String,
    activated_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IngestEvent {
    account_id: String,
    source_id: String,
    event_id: String,
    target_event_id: Option<String>,
    kind: String,
    sender: String,
    occurred_at: DateTime<Utc>,
    body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    attachment: Option<MediaAttachment>,
}

#[derive(Clone, Serialize, Deserialize)]
struct MediaAttachment {
    file_name: String,
    source: MediaSource,
    #[serde(default)]
    declared_size: Option<u64>,
}

fn media_attachment(
    name: &str,
    source: &MediaSource,
    declared_size: Option<u64>,
) -> MediaAttachment {
    let file_name: String = name
        .chars()
        .filter(|ch| !ch.is_control())
        .take(200)
        .collect();
    MediaAttachment {
        file_name: if file_name.is_empty() {
            "attachment".into()
        } else {
            file_name
        },
        source: source.clone(),
        declared_size,
    }
}

async fn download_media_bounded(
    api: &Api,
    client: &Client,
    source: &MediaSource,
) -> Result<Option<Vec<u8>>> {
    let uri = match source {
        MediaSource::Plain(uri) => uri,
        MediaSource::Encrypted(file) => &file.url,
    };
    let (server, media_id) = uri.parts()?;
    let token = client
        .access_token()
        .context("Matrix access token unavailable")?;
    let mut response = None;
    for segments in [
        ["_matrix", "client", "v1", "media", "download"],
        ["_matrix", "media", "v3", "download", ""],
    ] {
        let mut url = client.homeserver();
        {
            let mut path = url
                .path_segments_mut()
                .map_err(|_| anyhow::anyhow!("invalid Matrix homeserver URL"))?;
            path.pop_if_empty()
                .extend(segments.iter().filter(|part| !part.is_empty()).copied())
                .push(server.as_str())
                .push(media_id);
        }
        let candidate = api
            .client
            .get(url)
            .bearer_auth(&token)
            .timeout(Duration::from_secs(120))
            .send()
            .await?;
        if candidate.status() == reqwest::StatusCode::NOT_FOUND {
            continue;
        }
        response = Some(candidate.error_for_status()?);
        break;
    }
    let response = response.context("Matrix media download endpoint unavailable")?;
    let Some(ciphertext) = read_media_bounded(response, MAX_ATTACHMENT_BYTES).await? else {
        return Ok(None);
    };
    if let MediaSource::Encrypted(file) = source {
        let mut cursor = Cursor::new(ciphertext);
        let mut decryptor = AttachmentDecryptor::new(&mut cursor, file.as_ref().clone().into())?;
        let mut plaintext = Vec::new();
        decryptor.read_to_end(&mut plaintext)?;
        if plaintext.len() > MAX_ATTACHMENT_BYTES {
            return Ok(None);
        }
        Ok(Some(plaintext))
    } else {
        Ok(Some(ciphertext))
    }
}

async fn read_media_bounded(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<Option<Vec<u8>>> {
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if chunk.len() > limit - bytes.len() {
            return Ok(None);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Some(bytes))
}

impl Api {
    async fn credentials(&self) -> Result<Option<MatrixCredentials>> {
        let response: MatrixConfigResponse = self
            .client
            .get(format!("{}/internal/integrations/matrix/config", self.base))
            .bearer_auth(&self.token)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(response.config)
    }

    async fn post<T: Serialize + ?Sized>(&self, path: &str, body: &T) -> Result<()> {
        self.client
            .post(format!("{}{path}", self.base))
            .bearer_auth(&self.token)
            .json(body)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    async fn bindings(&self) -> Result<HashMap<String, Binding>> {
        let response: BindingResponse = self
            .client
            .get(format!(
                "{}/internal/integrations/matrix/bindings",
                self.base
            ))
            .bearer_auth(&self.token)
            .query(&[("accountId", &self.account_id)])
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(response
            .sources
            .into_iter()
            .map(|binding| (binding.source_id.clone(), binding))
            .collect())
    }

    async fn report_account(
        &self,
        endpoint: &str,
        status: &str,
        error: Option<String>,
    ) -> Result<()> {
        self.post(
            "/internal/integrations/matrix/account",
            &serde_json::json!({
                "id": self.account_id, "endpoint": endpoint, "displayName": self.account_id,
                "status": status, "lastError": error,
            }),
        )
        .await
    }

    async fn discover(&self, room: &Room) -> Result<()> {
        let name = room.name().unwrap_or_else(|| room.room_id().to_string());
        let name: String = name
            .chars()
            .filter(|ch| !ch.is_control())
            .take(80)
            .collect();
        let name = if name.trim().is_empty() {
            room.room_id().to_string()
        } else {
            name
        };
        self.post(
            "/internal/integrations/matrix/source",
            &serde_json::json!({
                "accountId": self.account_id,
                "sourceId": room.room_id().to_string(),
                "displayName": name,
                "inviter": null,
            }),
        )
        .await
    }

    async fn ingest(&self, event: &IngestEvent) -> Result<()> {
        self.post("/internal/integrations/matrix/event", event)
            .await
    }

    async fn ingest_attachment(&self, event: &IngestEvent, bytes: &[u8]) -> Result<()> {
        let attachment = event.attachment.as_ref().context("missing media source")?;
        let mut event_value = serde_json::to_value(event)?;
        event_value
            .as_object_mut()
            .context("invalid event payload")?
            .remove("attachment");
        self.post(
            "/internal/integrations/matrix/attachment",
            &serde_json::json!({
                "event": event_value,
                "fileName": attachment.file_name,
                "data": BASE64.encode(bytes),
            }),
        )
        .await
    }
}

struct Outbox {
    path: PathBuf,
}

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let temporary = path.with_extension(format!("{now}.{sequence}.tmp"));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    std::fs::rename(&temporary, path)?;
    std::fs::File::open(path.parent().context("file has no parent")?)?.sync_all()?;
    Ok(())
}

impl Outbox {
    async fn new(path: PathBuf) -> Result<Self> {
        fs::create_dir_all(&path).await?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
        Ok(Self { path })
    }

    fn file(&self, event: &IngestEvent) -> PathBuf {
        let digest = Sha256::digest(format!(
            "{}\0{}\0{}",
            event.account_id, event.source_id, event.event_id
        ));
        self.path.join(format!("{digest:x}.json"))
    }

    async fn enqueue(&self, event: &IngestEvent) -> Result<()> {
        let target = self.file(event);
        write_private_atomic(&target, &serde_json::to_vec(event)?)?;
        Ok(())
    }

    async fn flush(
        &self,
        api: &Api,
        client: &Client,
        bindings: &HashMap<String, Binding>,
    ) -> Result<usize> {
        let mut entries = fs::read_dir(&self.path).await?;
        let mut pending = Vec::new();
        let mut failures = 0;
        while let Some(entry) = entries.next_entry().await? {
            if entry.path().extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let event: IngestEvent = serde_json::from_slice(&fs::read(entry.path()).await?)?;
            pending.push((entry.path(), event));
        }
        pending.sort_by(|(_, left), (_, right)| {
            left.occurred_at
                .cmp(&right.occurred_at)
                .then_with(|| (left.kind != "message").cmp(&(right.kind != "message")))
                .then_with(|| left.event_id.cmp(&right.event_id))
        });
        for (path, event) in pending {
            let Some(binding) = bindings.get(&event.source_id) else {
                fs::remove_file(path).await?;
                continue;
            };
            if binding
                .activated_at
                .is_some_and(|activated| event.occurred_at < activated)
            {
                fs::remove_file(path).await?;
                continue;
            }
            if binding.status != "active" {
                continue;
            }
            let result = if let Some(attachment) = &event.attachment {
                if attachment
                    .declared_size
                    .is_some_and(|size| size > MAX_ATTACHMENT_BYTES as u64)
                {
                    let mut skipped = event.clone();
                    skipped.attachment = None;
                    skipped.body = Some(format!(
                        "Attachment exceeds the 50 MiB import limit: {}",
                        attachment.file_name
                    ));
                    api.ingest(&skipped).await
                } else {
                    match download_media_bounded(api, client, &attachment.source).await {
                        Ok(Some(bytes)) if bytes.is_empty() => {
                            let mut skipped = event.clone();
                            skipped.attachment = None;
                            skipped.body = Some(format!(
                                "Empty attachment skipped: {}",
                                attachment.file_name
                            ));
                            api.ingest(&skipped).await
                        }
                        Ok(Some(bytes)) => api.ingest_attachment(&event, &bytes).await,
                        Ok(None) => {
                            let mut skipped = event.clone();
                            skipped.attachment = None;
                            skipped.body = Some(format!(
                                "Attachment exceeds the 50 MiB import limit: {}",
                                attachment.file_name
                            ));
                            api.ingest(&skipped).await
                        }
                        Err(error) => Err(error.into()),
                    }
                }
            } else {
                api.ingest(&event).await
            };
            match result {
                Ok(()) => {
                    fs::remove_file(path).await?;
                }
                Err(error) => {
                    failures += 1;
                    warn!(event_id = %event.event_id, %error, "event import will retry");
                }
            }
        }
        Ok(failures)
    }
}

fn timestamp(milliseconds: i64) -> Option<DateTime<Utc>> {
    DateTime::from_timestamp_millis(milliseconds)
}

fn bounded_body(value: &str) -> String {
    const LIMIT: usize = 8_000;
    let mut chars = value.chars();
    let first: String = chars.by_ref().take(LIMIT).collect();
    if chars.next().is_some() {
        format!("{first}\n[Message truncated after {LIMIT} characters]")
    } else {
        first
    }
}

async fn connect(config: &Config, credentials: &MatrixCredentials) -> Result<Client> {
    fs::create_dir_all(&config.data_dir).await?;
    std::fs::set_permissions(&config.data_dir, std::fs::Permissions::from_mode(0o700))?;
    let client = Client::builder()
        .homeserver_url(&credentials.endpoint)
        .sqlite_store(
            config.data_dir.join("crypto"),
            Some(&config.store_passphrase),
        )
        .build()
        .await?;
    let session_path = config.data_dir.join("matrix-session.json");
    if session_path.exists() {
        let session: MatrixSession = serde_json::from_slice(&fs::read(&session_path).await?)?;
        if !credentials.username.starts_with('@')
            || session.meta.user_id.as_str() != credentials.username
        {
            bail!(
                "Saved Matrix device belongs to another account; reset the connector data volume before switching accounts"
            );
        }
        client.restore_session(session).await?;
    } else {
        client
            .matrix_auth()
            .login_username(&credentials.username, &credentials.password)
            .initial_device_display_name("Verity knowledge connector")
            .await?;
        let session = client
            .matrix_auth()
            .session()
            .context("Matrix login did not create a session")?;
        write_private_atomic(&session_path, &serde_json::to_vec(&session)?)?;
    }
    Ok(client)
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let config = Config::from_env()?;
    let mut http_builder = reqwest::Client::builder().timeout(Duration::from_secs(15));
    if let Some(path) = &config.verity_ca_cert_path {
        let certificate = reqwest::Certificate::from_pem(&fs::read(path).await?)?;
        http_builder = http_builder.add_root_certificate(certificate);
    }
    let mut api = Api {
        client: http_builder.build()?,
        base: config.verity_url.trim_end_matches('/').to_string(),
        token: config.connector_token.clone(),
        account_id: String::new(),
    };
    let credentials = loop {
        match api.credentials().await {
            Ok(Some(value)) => break value,
            Ok(None) => info!("waiting for Matrix account in project settings"),
            Err(error) => warn!(%error, "cannot read Matrix account configuration"),
        }
        sleep(Duration::from_secs(10)).await;
    };
    if !credentials.endpoint.starts_with("https://") {
        bail!("Matrix homeserver must use HTTPS");
    }
    let client = connect(&config, &credentials).await?;
    api.account_id = client
        .user_id()
        .context("Matrix user ID unavailable")?
        .to_string();
    let outbox = Arc::new(Outbox::new(config.data_dir.join("outbox")).await?);
    let bindings = Arc::new(RwLock::new(api.bindings().await?));
    api.report_account(&credentials.endpoint, "offline", None)
        .await?;

    {
        let api = api.clone();
        let outbox = outbox.clone();
        let bindings = bindings.clone();
        client.add_event_handler(move |event: OriginalSyncRoomMessageEvent, room: Room| {
            let api = api.clone();
            let outbox = outbox.clone();
            let bindings = bindings.clone();
            async move {
                let room_id = room.room_id().to_string();
                if !bindings
                    .read()
                    .await
                    .get(&room_id)
                    .is_some_and(|binding| binding.status == "active")
                {
                    return;
                }
                let (kind, target_event_id, body, attachment) = match &event.content.relates_to {
                    Some(Relation::Replacement(replacement)) => {
                        let MessageType::Text(text) = &replacement.new_content.msgtype else {
                            return;
                        };
                        (
                            "edit",
                            Some(replacement.event_id.to_string()),
                            Some(bounded_body(&text.body)),
                            None,
                        )
                    }
                    _ => match &event.content.msgtype {
                        MessageType::Text(text) => {
                            ("message", None, Some(bounded_body(&text.body)), None)
                        }
                        MessageType::Image(media) => (
                            "message",
                            None,
                            Some(format!("Attachment: {}", bounded_body(&media.body))),
                            Some(media_attachment(
                                media.filename(),
                                &media.source,
                                media
                                    .info
                                    .as_ref()
                                    .and_then(|info| info.size)
                                    .map(u64::from),
                            )),
                        ),
                        MessageType::File(media) => (
                            "message",
                            None,
                            Some(format!("Attachment: {}", bounded_body(&media.body))),
                            Some(media_attachment(
                                media.filename(),
                                &media.source,
                                media
                                    .info
                                    .as_ref()
                                    .and_then(|info| info.size)
                                    .map(u64::from),
                            )),
                        ),
                        MessageType::Audio(media) => (
                            "message",
                            None,
                            Some(format!("Attachment: {}", bounded_body(&media.body))),
                            Some(media_attachment(
                                media.filename(),
                                &media.source,
                                media
                                    .info
                                    .as_ref()
                                    .and_then(|info| info.size)
                                    .map(u64::from),
                            )),
                        ),
                        MessageType::Video(media) => (
                            "message",
                            None,
                            Some(format!("Attachment: {}", bounded_body(&media.body))),
                            Some(media_attachment(
                                media.filename(),
                                &media.source,
                                media
                                    .info
                                    .as_ref()
                                    .and_then(|info| info.size)
                                    .map(u64::from),
                            )),
                        ),
                        _ => return,
                    },
                };
                let Some(occurred_at) = timestamp(i64::from(event.origin_server_ts.0)) else {
                    return;
                };
                let queued = IngestEvent {
                    account_id: api.account_id.clone(),
                    source_id: room_id,
                    event_id: event.event_id.to_string(),
                    target_event_id,
                    kind: kind.to_string(),
                    sender: event.sender.to_string(),
                    occurred_at,
                    body,
                    attachment,
                };
                if let Err(error) = outbox.enqueue(&queued).await {
                    error!(%error, "failed to queue Matrix message");
                }
            }
        });
    }
    {
        let api = api.clone();
        let outbox = outbox.clone();
        let bindings = bindings.clone();
        client.add_event_handler(move |event: OriginalSyncRoomRedactionEvent, room: Room| {
            let api = api.clone();
            let outbox = outbox.clone();
            let bindings = bindings.clone();
            async move {
                let room_id = room.room_id().to_string();
                if !bindings
                    .read()
                    .await
                    .get(&room_id)
                    .is_some_and(|binding| binding.status == "active")
                {
                    return;
                }
                let Some(target) = event.redacts.as_ref().or(event.content.redacts.as_ref()) else {
                    return;
                };
                let Some(occurred_at) = timestamp(i64::from(event.origin_server_ts.0)) else {
                    return;
                };
                let queued = IngestEvent {
                    account_id: api.account_id.clone(),
                    source_id: room_id,
                    event_id: event.event_id.to_string(),
                    target_event_id: Some(target.to_string()),
                    kind: "redaction".to_string(),
                    sender: event.sender.to_string(),
                    occurred_at,
                    body: None,
                    attachment: None,
                };
                if let Err(error) = outbox.enqueue(&queued).await {
                    error!(%error, "failed to queue Matrix redaction");
                }
            }
        });
    }

    let sync_client = client.clone();
    let sync_healthy = Arc::new(AtomicBool::new(false));
    let sync_health = sync_healthy.clone();
    tokio::spawn(async move {
        loop {
            let health = sync_health.clone();
            if let Err(error) = sync_client
                .sync_with_result_callback(SyncSettings::default(), move |result| {
                    let health = health.clone();
                    async move {
                        match result {
                            Ok(_) => {
                                health.store(true, Ordering::Relaxed);
                                Ok(LoopCtrl::Continue)
                            }
                            Err(error) => {
                                health.store(false, Ordering::Relaxed);
                                Err(error)
                            }
                        }
                    }
                })
                .await
            {
                error!(%error, "Matrix sync stopped; retrying");
            }
            sync_health.store(false, Ordering::Relaxed);
            sleep(Duration::from_secs(5)).await;
        }
    });

    loop {
        match api.bindings().await {
            Ok(next) => {
                *bindings.write().await = next.clone();
                for room in client.joined_rooms() {
                    if !next.contains_key(room.room_id().as_str()) {
                        if let Err(error) = api.discover(&room).await {
                            warn!(room = %room.room_id(), %error, "could not report joined room");
                        }
                    }
                }
                for room in client.invited_rooms() {
                    if !next.contains_key(room.room_id().as_str()) {
                        if let Err(error) = api.discover(&room).await {
                            warn!(%error, "could not report invitation");
                        }
                    }
                    if next
                        .get(room.room_id().as_str())
                        .is_some_and(|binding| binding.status == "active")
                    {
                        if let Err(error) = room.join().await {
                            warn!(%error, "could not join assigned room");
                        }
                    }
                }
                match outbox.flush(&api, &client, &next).await {
                    Ok(0) if sync_healthy.load(Ordering::Relaxed) => {
                        if let Err(error) = api
                            .report_account(&credentials.endpoint, "online", None)
                            .await
                        {
                            warn!(%error, "could not update connector status");
                        }
                    }
                    Ok(0) => {
                        if let Err(error) = api
                            .report_account(
                                &credentials.endpoint,
                                "offline",
                                Some("Waiting for Matrix sync".to_string()),
                            )
                            .await
                        {
                            warn!(%error, "could not update connector status");
                        }
                    }
                    Ok(failures) => {
                        let note = format!("{failures} message imports are retrying");
                        if let Err(error) = api
                            .report_account(&credentials.endpoint, "error", Some(note))
                            .await
                        {
                            warn!(%error, "could not update connector status");
                        }
                    }
                    Err(error) => warn!(%error, "outbox flush failed"),
                }
                info!(rooms = next.len(), "Matrix connector healthy");
            }
            Err(error) => warn!(%error, "cannot read room bindings"),
        }
        sleep(Duration::from_secs(10)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn media_stream_stops_at_limit_without_a_declared_length() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await.unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n123456")
                .await
                .unwrap();
        });
        let response = reqwest::Client::new()
            .get(format!("http://{address}/media"))
            .send()
            .await
            .unwrap();
        assert!(read_media_bounded(response, 5).await.unwrap().is_none());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn outbox_event_survives_reopening_and_is_private() {
        let path = std::env::temp_dir().join(format!(
            "verity-matrix-outbox-test-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let outbox = Outbox::new(path.clone()).await.unwrap();
        let event = IngestEvent {
            account_id: "@verity:example.test".to_string(),
            source_id: "!room:example.test".to_string(),
            event_id: "$one".to_string(),
            target_event_id: None,
            kind: "message".to_string(),
            sender: "@person:example.test".to_string(),
            occurred_at: Utc::now(),
            body: Some("hello".to_string()),
            attachment: None,
        };
        outbox.enqueue(&event).await.unwrap();
        let reopened = Outbox::new(path.clone()).await.unwrap();
        let bytes = fs::read(reopened.file(&event)).await.unwrap();
        let stored: IngestEvent = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(stored.event_id, event.event_id);
        assert_eq!(
            std::fs::metadata(reopened.file(&event))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        fs::remove_dir_all(path).await.unwrap();
    }

    #[test]
    fn media_source_survives_outbox_serialization() {
        let attachment = MediaAttachment {
            file_name: "notes.pdf".into(),
            source: MediaSource::Plain("mxc://example.test/notes".into()),
            declared_size: Some(42),
        };
        let encoded = serde_json::to_vec(&attachment).unwrap();
        let decoded: MediaAttachment = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded.file_name, "notes.pdf");
        assert_eq!(
            serde_json::to_value(decoded.source).unwrap(),
            serde_json::to_value(attachment.source).unwrap()
        );
    }

    #[test]
    fn long_message_has_a_visible_truncation_marker() {
        let result = bounded_body(&"x".repeat(8_001));
        assert!(result.contains("[Message truncated after 8000 characters]"));
        assert_eq!(result.matches('x').count(), 8_000);
    }
}
