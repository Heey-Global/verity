export function attachmentsClient(request: (path: string, init: RequestInit) => Promise<Response>) {
  return {
    async getMockupPreviewDocument(
      this: void,
      attachment: string,
      signal: AbortSignal,
    ): Promise<string> {
      const response = await request(`/attachments/${encodeURIComponent(attachment)}?mockup=1`, {
        method: 'GET',
        signal,
      });
      if (response.headers.get('content-type')?.split(';', 1)[0] !== 'text/html') {
        throw new Error('Invalid mockup preview response');
      }
      return response.text();
    },

    async readTaskAttachment(this: void, id: string, hash: string): Promise<ArrayBuffer> {
      const response = await request(
        `/tasks/${encodeURIComponent(id)}/attachments/${encodeURIComponent(hash)}`,
        { method: 'GET' },
      );
      return response.arrayBuffer();
    },
  };
}
