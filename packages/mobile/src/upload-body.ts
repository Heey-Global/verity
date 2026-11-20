// How every upload route wants its bytes sent, shared by the client's upload calls.

/** The picked file as a body that always reports `application/octet-stream`. */
export function uploadBodyWithMimeType(data: Blob): Blob {
  if (data.type === 'application/octet-stream') return data;

  // expo/fetch copies the body Blob's `type` into its native Content-Type
  // header, overriding the one the caller set. Two ways that breaks an upload:
  // expo-file-system's File reports `null` when iOS cannot infer a MIME type,
  // and the native bridge accepts strings only, so the request fails before it
  // is sent; and when iOS *does* infer one, the picked file's own type (a PDF's
  // `application/pdf`, say) replaces the `application/octet-stream` the upload
  // routes are declared with. Always report the binary type both upload
  // endpoints expect — they stream raw bytes and take the real media type from
  // the file name or an explicit header. Preserve the native file object and
  // all of its file-backed methods; native methods are bound to the original
  // host object because Expo host objects can reject a Proxy as their receiver.
  return new Proxy(data, {
    get(target, property) {
      if (property === 'type') return 'application/octet-stream';
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const boundValue: unknown = value.bind(target);
      return boundValue;
    },
  });
}
