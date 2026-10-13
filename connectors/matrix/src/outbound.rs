use super::Api;
use anyhow::{Context, Result};
use matrix_sdk::{
    Client, EncryptionState, RoomState,
    config::RequestConfig,
    ruma::{
        OwnedRoomId, OwnedTransactionId,
        api::client::state::get_state_event_for_key,
        api::error::{ErrorKind, RetryAfter},
        events::{
            StateEventType,
            room::{
                encryption::PossiblyRedactedRoomEncryptionEventContent,
                member::{MembershipState, RoomMemberEventContent},
                message::RoomMessageEventContent,
            },
        },
    },
};
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Job {
    invocation_id: String,
    transaction_id: String,
    lease_id: String,
    account_id: String,
    endpoint: String,
    room_id: OwnedRoomId,
    room_name: String,
    binding_version: u32,
    body: String,
}
#[derive(Deserialize)]
struct Claim {
    job: Option<Job>,
}
#[derive(Deserialize)]
struct Check {
    allowed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Outcome {
    account_id: String,
    invocation_id: String,
    lease_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    event_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_ms: Option<u64>,
}

fn retry_delay(error: &matrix_sdk::Error) -> Option<u64> {
    let Some(api) = error.as_client_api_error() else {
        return Some(30_000);
    };
    if let Some(ErrorKind::LimitExceeded(limit)) = api.error_kind() {
        let delay = match &limit.retry_after {
            Some(RetryAfter::Delay(delay)) => delay.as_millis() as u64,
            Some(RetryAfter::DateTime(at)) => at
                .duration_since(SystemTime::now())
                .unwrap_or_default()
                .as_millis() as u64,
            _ => 30_000,
        };
        // A delay beyond the server's queue limit becomes a terminal failure, never an early retry.
        return (delay <= 86_400_000).then_some(delay.max(10_000));
    }
    api.status_code.is_server_error().then_some(30_000)
}

impl Api {
    async fn outbound_request<T: serde::de::DeserializeOwned>(
        &self,
        action: &str,
        body: serde_json::Value,
    ) -> Result<T> {
        Ok(self
            .client
            .post(format!(
                "{}/internal/integrations/matrix/outbound/{action}",
                self.base
            ))
            .bearer_auth(&self.token)
            .json(&body)
            .timeout(Duration::from_secs(15))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?)
    }

    pub(super) async fn dispatch_outbound(&self, client: &Client) -> Result<()> {
        let claim: Claim = self
            .outbound_request("claim", serde_json::json!({ "accountId": self.account_id }))
            .await?;
        let Some(job) = claim.job else {
            return Ok(());
        };
        let mut outcome = Outcome {
            account_id: self.account_id.clone(),
            invocation_id: job.invocation_id.clone(),
            lease_id: job.lease_id.clone(),
            event_id: None,
            error: None,
            retry_after_ms: None,
        };
        if job.account_id != self.account_id
            || client.user_id().map(|id| id.as_str()) != Some(job.account_id.as_str())
            || client.homeserver().as_str().trim_end_matches('/')
                != job.endpoint.trim_end_matches('/')
            || job.binding_version == 0
            || job.room_name.is_empty()
            || job.body.trim().is_empty()
            || job.body.chars().count() > 8_000
        {
            outcome.error = Some("send_failed");
        } else if let Some(room) = client
            .get_room(&job.room_id)
            .filter(|room| room.state() == RoomState::Joined)
        {
            // Unknown encryption state is never permission to send plaintext. Room::send also
            // establishes Megolm before submitting encrypted messages. Its encryption-state
            // helper can reuse cached state, so explicitly fetch and persist current state here.
            let preflight = async {
                let request = get_state_event_for_key::v3::Request::new(
                    job.room_id.clone(),
                    StateEventType::RoomMember,
                    job.account_id.clone(),
                );
                let response = client
                    .send(request)
                    .with_request_config(RequestConfig::new().retry_limit(0))
                    .await
                    .map_err(matrix_sdk::Error::from)?;
                let member: RoomMemberEventContent =
                    serde_json::from_str(response.event_or_content.get())?;
                if member.membership != MembershipState::Join {
                    return Ok::<_, anyhow::Error>(None);
                }
                let request = get_state_event_for_key::v3::Request::new(
                    job.room_id.clone(),
                    StateEventType::RoomEncryption,
                    String::new(),
                );
                let encryption = match client
                    .send(request)
                    .with_request_config(RequestConfig::new().retry_limit(0))
                    .await
                {
                    Ok(response) => Some(
                        response
                            .into_content()
                            .deserialize_as_unchecked::<PossiblyRedactedRoomEncryptionEventContent>(
                            )?,
                    ),
                    Err(error)
                        if error.client_api_error_kind() == Some(&ErrorKind::NotFound)
                            && !room.encryption_state().is_encrypted() =>
                    {
                        None
                    }
                    Err(error) => return Err(matrix_sdk::Error::from(error).into()),
                };
                room.update_and_save_room_info(|mut info| {
                    info.mark_encryption_state_synced();
                    info.set_encryption_event(encryption);
                    (info, Default::default())
                })
                .await?;
                Ok(Some(room.encryption_state()))
            };
            match tokio::time::timeout(Duration::from_secs(30), preflight).await {
                Ok(Ok(Some(EncryptionState::Encrypted | EncryptionState::NotEncrypted))) => {
                    let check: Check = self.outbound_request("check", serde_json::json!({
                        "accountId": self.account_id, "invocationId": job.invocation_id, "leaseId": job.lease_id
                    })).await?;
                    if !check.allowed {
                        return Ok(());
                    }
                    let transaction: OwnedTransactionId = job.transaction_id.into();
                    let send = room
                        .send(RoomMessageEventContent::text_plain(job.body))
                        .with_transaction_id(transaction)
                        .with_request_config(RequestConfig::new().retry_limit(0));
                    // The server owns all retries, so every new attempt rechecks the binding.
                    match tokio::time::timeout(Duration::from_secs(120), send).await {
                        Ok(Ok(sent)) => outcome.event_id = Some(sent.response.event_id.to_string()),
                        Ok(Err(error)) => {
                            outcome.error = Some("send_failed");
                            outcome.retry_after_ms = retry_delay(&error);
                        }
                        Err(_) => {
                            outcome.error = Some("send_outcome_unknown");
                            outcome.retry_after_ms = Some(30_000);
                        }
                    }
                }
                Ok(Ok(None)) => {
                    outcome.error = Some("room_not_joined");
                }
                Ok(Err(error)) => {
                    outcome.error = Some("encryption_unavailable");
                    outcome.retry_after_ms = error
                        .downcast_ref::<matrix_sdk::Error>()
                        .map_or(Some(30_000), retry_delay);
                }
                _ => {
                    outcome.error = Some("encryption_unavailable");
                    outcome.retry_after_ms = Some(30_000);
                }
            }
        } else {
            outcome.error = Some("room_not_joined");
        }
        self.post("/internal/integrations/matrix/outbound/result", &outcome)
            .await
            .context("could not acknowledge Matrix send; its stable transaction will be retried")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approved_job_preserves_exact_text_and_transaction() {
        let job: Job = serde_json::from_value(serde_json::json!({
            "invocationId": "invocation", "transactionId": "verity-invocation", "leaseId": "lease",
            "accountId": "@verity:example.org", "endpoint": "https://example.org",
            "roomId": "!room:example.org", "roomName": "Room", "bindingVersion": 2,
            "body": "literal {{template}}\nsecond line"
        }))
        .unwrap();
        let content = RoomMessageEventContent::text_plain(job.body.clone());
        let encoded = serde_json::to_value(content).unwrap();
        assert_eq!(encoded["msgtype"], "m.text");
        assert_eq!(encoded["body"], job.body);
        assert_eq!(job.transaction_id, "verity-invocation");
        assert!(encoded.get("formatted_body").is_none());
    }

    #[test]
    fn result_never_claims_bridge_delivery_and_does_not_include_message_text() {
        let result = Outcome {
            account_id: "account".into(),
            invocation_id: "invocation".into(),
            lease_id: "lease".into(),
            event_id: Some("$event".into()),
            error: None,
            retry_after_ms: None,
        };
        let encoded = serde_json::to_value(result).unwrap();
        assert_eq!(encoded["eventId"], "$event");
        assert!(encoded.get("body").is_none());
        assert!(encoded.get("error").is_none());
    }
}

#[cfg(test)]
#[path = "outbound_tests.rs"]
mod dispatch_tests;
