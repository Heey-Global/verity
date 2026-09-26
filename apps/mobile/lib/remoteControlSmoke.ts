import { requireNativeModule } from 'expo-modules-core';
import {
  requestRemoteControlAdmission,
  type RemoteAdmissionOptions,
} from './remoteControlAdmission';

interface NativeRemoteSmoke {
  requestOnce(
    dataUrl: string,
    ticket: string,
    sessionId: string,
    coreUrl: string,
    corePin: string,
  ): Promise<{ status: number; bodyBase64: string }>;
}

export interface RemoteSmokeOptions extends RemoteAdmissionOptions {
  /** The paired logical Core URL, never a destination chosen by a stream frame. */
  coreUrl: string;
  corePin: string;
}

/** A single opt-in GET through the remote tunnel; no normal app route calls this. */
export async function remoteControlSmokeGet(
  options: RemoteSmokeOptions,
): Promise<{ status: number; bodyBase64: string }> {
  const admission = await requestRemoteControlAdmission(options);
  try {
    const dataUrl = new URL(options.uplinkOrigin);
    dataUrl.protocol = 'wss:';
    dataUrl.pathname = '/data';
    const native = requireNativeModule<NativeRemoteSmoke>('VerityRemoteControlSmoke');
    const result = await native.requestOnce(
      dataUrl.href,
      admission.ticket,
      admission.sessionId,
      options.coreUrl,
      options.corePin,
    );
    admission.finish();
    return result;
  } catch (error) {
    admission.cancel();
    throw error;
  }
}
