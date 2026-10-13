use super::*;
use matrix_sdk::{
    authentication::matrix::MatrixSession, config::SyncSettings, ruma::api::MatrixVersion,
};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Fixture {
    api: Api,
    client: Client,
    requests: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Fixture {
    async fn new(encrypted: bool, allowed: bool, joined: bool, encryption_error: bool) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let server_base = base.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let recorded = recorded.clone();
                let base = server_base.clone();
                tokio::spawn(async move {
                    let mut raw = Vec::new();
                    let mut buffer = [0u8; 4096];
                    let end = loop {
                        let count = socket.read(&mut buffer).await.unwrap();
                        if count == 0 {
                            return;
                        }
                        raw.extend_from_slice(&buffer[..count]);
                        if let Some(end) = raw.windows(4).position(|part| part == b"\r\n\r\n") {
                            let headers = String::from_utf8_lossy(&raw[..end]).to_lowercase();
                            let length: usize = headers
                                .lines()
                                .find_map(|line| line.strip_prefix("content-length: "))
                                .unwrap_or("0")
                                .parse()
                                .unwrap();
                            if raw.len() >= end + 4 + length {
                                break end;
                            }
                        }
                    };
                    let headers = String::from_utf8_lossy(&raw[..end]);
                    let path = headers
                        .lines()
                        .next()
                        .unwrap()
                        .split_whitespace()
                        .nth(1)
                        .unwrap()
                        .to_owned();
                    let body: serde_json::Value =
                        serde_json::from_slice(&raw[end + 4..]).unwrap_or(serde_json::Value::Null);
                    recorded.lock().unwrap().push((path.clone(), body));
                    let mut status = 200;
                    let response = if path.ends_with("/outbound/claim") {
                        serde_json::json!({"job": {"accountId":"@verity:example.org", "endpoint":base,
                            "roomId":"!room:example.org", "roomName":"Room", "bindingVersion":1,
                            "body":"exact approved\ntext", "invocationId":"invocation", "leaseId":"lease",
                            "transactionId":"verity-stable"}})
                    } else if path.ends_with("/outbound/check") {
                        serde_json::json!({"allowed":allowed})
                    } else if path.ends_with("/outbound/result") {
                        serde_json::json!({"ok":true})
                    } else if path.contains("/state/m.room.member/") {
                        serde_json::json!({"membership": if joined {"join"} else {"leave"}})
                    } else if path.contains("/state/m.room.encryption") {
                        if encryption_error {
                            status = 403;
                            serde_json::json!({"errcode":"M_FORBIDDEN", "error":"unavailable"})
                        } else if encrypted {
                            serde_json::json!({"algorithm":"m.megolm.v1.aes-sha2"})
                        } else {
                            status = 404;
                            serde_json::json!({"errcode":"M_NOT_FOUND", "error":"not encrypted"})
                        }
                    } else if path.contains("/sync") {
                        let mut state = vec![
                            serde_json::json!({"type":"m.room.create", "state_key":"", "sender":"@verity:example.org", "event_id":"$create", "origin_server_ts":1, "content":{"creator":"@verity:example.org", "room_version":"10"}}),
                            serde_json::json!({"type":"m.room.member", "state_key":"@verity:example.org", "sender":"@verity:example.org", "event_id":"$member", "origin_server_ts":1, "content":{"membership":"join"}}),
                        ];
                        if encrypted {
                            state.push(serde_json::json!({"type":"m.room.encryption", "state_key":"", "sender":"@verity:example.org", "event_id":"$encryption", "origin_server_ts":1, "content":{"algorithm":"m.megolm.v1.aes-sha2"}}));
                        }
                        serde_json::json!({"next_batch":"batch", "rooms":{"join":{"!room:example.org":{
                            "state":{"events":state}, "timeline":{"events":[], "limited":false}, "ephemeral":{"events":[]}, "account_data":{"events":[]}
                        }}}, "device_one_time_keys_count":{"signed_curve25519":50}, "device_lists":{"changed":[], "left":[]}})
                    } else if path.contains("/members") {
                        serde_json::json!({"chunk":[{"type":"m.room.member", "state_key":"@verity:example.org", "sender":"@verity:example.org", "event_id":"$member", "origin_server_ts":1, "content":{"membership":"join"}}]})
                    } else if path.contains("/keys/upload") {
                        serde_json::json!({"one_time_key_counts":{"signed_curve25519":50}})
                    } else if path.contains("/keys/query") {
                        serde_json::json!({"device_keys":{}, "failures":{}})
                    } else if path.contains("/keys/claim") {
                        serde_json::json!({"one_time_keys":{}, "failures":{}})
                    } else if path.contains("/send/") {
                        serde_json::json!({"event_id":"$accepted"})
                    } else {
                        serde_json::json!({})
                    };
                    let response = response.to_string();
                    socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).as_bytes()).await.unwrap();
                });
            }
        });
        let client = Client::builder()
            .homeserver_url(&base)
            .server_versions([MatrixVersion::V1_11])
            .build()
            .await
            .unwrap();
        let session: MatrixSession = serde_json::from_value(serde_json::json!({"user_id":"@verity:example.org", "device_id":"TEST", "access_token":"mock-token"})).unwrap();
        client.restore_session(session).await.unwrap();
        client.sync_once(SyncSettings::default()).await.unwrap();
        Self {
            api: Api {
                client: reqwest::Client::new(),
                base,
                token: "connector-token".into(),
                account_id: "@verity:example.org".into(),
            },
            client,
            requests,
            server,
        }
    }
    async fn dispatch(&self) {
        tokio::time::timeout(
            Duration::from_secs(10),
            self.api.dispatch_outbound(&self.client),
        )
        .await
        .unwrap()
        .unwrap();
    }
    fn sends(&self) -> Vec<(String, serde_json::Value)> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(path, _)| path.contains("/send/"))
            .cloned()
            .collect()
    }
}

#[tokio::test]
async fn encrypted_dispatch_uses_ciphertext_and_the_same_transaction_on_retry() {
    let fixture = Fixture::new(true, true, true, false).await;
    fixture.dispatch().await;
    fixture.dispatch().await;
    let sends = fixture.sends();
    assert_eq!(sends.len(), 2);
    assert_eq!(sends[0].0, sends[1].0);
    assert!(sends[0].0.contains("/m.room.encrypted/verity-stable"));
    assert_eq!(sends[0].1["algorithm"], "m.megolm.v1.aes-sha2");
    assert!(sends[0].1.get("body").is_none());
    assert!(!sends[0].1.to_string().contains("exact approved"));
    let requests = fixture.requests.lock().unwrap();
    assert!(
        requests.iter().any(
            |(path, body)| path.ends_with("/outbound/result") && body["eventId"] == "$accepted"
        )
    );
}

#[tokio::test]
async fn denied_binding_and_changed_membership_never_send() {
    for (allowed, joined) in [(false, true), (true, false)] {
        let fixture = Fixture::new(false, allowed, joined, false).await;
        fixture.dispatch().await;
        assert!(fixture.sends().is_empty());
    }
}

#[tokio::test]
async fn encryption_failure_never_falls_back_to_plaintext() {
    let fixture = Fixture::new(true, true, true, true).await;
    fixture.dispatch().await;
    assert!(fixture.sends().is_empty());
    assert!(
        fixture
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|(path, body)| path.ends_with("/outbound/result")
                && body["error"] == "encryption_unavailable")
    );
}

#[tokio::test]
async fn unencrypted_dispatch_sends_only_the_approved_plain_text() {
    let fixture = Fixture::new(false, true, true, false).await;
    fixture.dispatch().await;
    let sends = fixture.sends();
    assert_eq!(sends.len(), 1);
    assert!(sends[0].0.contains("/m.room.message/verity-stable"));
    assert_eq!(sends[0].1["msgtype"], "m.text");
    assert_eq!(sends[0].1["body"], "exact approved\ntext");
}

#[tokio::test]
async fn newly_encrypted_room_cannot_use_a_cached_plaintext_state() {
    let fixture = Fixture::new(true, true, true, false).await;
    let room = fixture
        .client
        .get_room(matrix_sdk::ruma::room_id!("!room:example.org"))
        .unwrap();
    room.update_and_save_room_info(|mut info| {
        info.mark_encryption_state_synced();
        info.set_encryption_event(None);
        (info, Default::default())
    })
    .await
    .unwrap();
    assert!(matches!(
        room.encryption_state(),
        EncryptionState::NotEncrypted
    ));
    fixture.dispatch().await;
    let sends = fixture.sends();
    assert_eq!(sends.len(), 1);
    assert!(sends[0].0.contains("/m.room.encrypted/"));
    assert!(sends[0].1.get("body").is_none());
}
