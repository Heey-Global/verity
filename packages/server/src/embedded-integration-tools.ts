import type { EventStore, SealableSecretCipher } from '@verity/store';
import { createGoogleAccountAccessToken } from './google-account-token.js';
import { createMatrixTool } from './matrix-tool.js';
import { createGoogleSlidesTool } from './google-slides-tool.js';
import { createGoogleDocsTool } from './google-docs-tool.js';
import { createGoogleContactsTool } from './google-contacts-tool.js';
import { createGoogleCalendarTool } from './google-calendar-tool.js';
import { createGmailTool } from './gmail-tool.js';
import { createGoogleSheetsTool } from './google-sheets-tool.js';
import { createGoogleDriveAgentTool } from './google-drive-agent-tool.js';

export function createEmbeddedIntegrationTools(
  eventStore: EventStore,
  secretCipher: Pick<SealableSecretCipher, 'isSealed'>,
) {
  const googleAccessToken = createGoogleAccountAccessToken(eventStore, {
    isSealed: () => secretCipher.isSealed(),
  });
  const googleSlidesTool = createGoogleSlidesTool({ eventStore, googleAccessToken });
  const invokeGoogleSlides = googleSlidesTool.invoke;
  const googleDocsTool = createGoogleDocsTool({ eventStore, googleAccessToken });
  const invokeGoogleDocs: typeof googleDocsTool.invoke = (input) => googleDocsTool.invoke(input);
  const googleSheetsTool = createGoogleSheetsTool({ eventStore, googleAccessToken });
  const invokeGoogleSheets: typeof googleSheetsTool.invoke = (input) =>
    googleSheetsTool.invoke(input);
  const googleContactsTool = createGoogleContactsTool({ eventStore, googleAccessToken });
  const invokeGoogleContacts: typeof googleContactsTool.invoke = (input) =>
    googleContactsTool.invoke(input);
  const googleCalendarTool = createGoogleCalendarTool({ eventStore, googleAccessToken });
  const invokeGoogleCalendar: typeof googleCalendarTool.invoke = (input) =>
    googleCalendarTool.invoke(input);
  const matrixTool = createMatrixTool({ eventStore });
  const gmailTool = createGmailTool({ eventStore, googleAccessToken });
  const invokeGmail: typeof gmailTool.invoke = (input) => gmailTool.invoke(input);
  const googleDriveTool = createGoogleDriveAgentTool({ eventStore, googleAccessToken });
  const invokeGoogleDrive: typeof googleDriveTool.invoke = (input) => googleDriveTool.invoke(input);

  return {
    googleAccessToken,
    googleSlidesTool,
    invokeGoogleSlides,
    invokeGoogleDocs,
    invokeGoogleSheets,
    invokeGoogleContacts,
    invokeGoogleCalendar,
    matrixTool,
    invokeGmail,
    googleDriveTool,
    invokeGoogleDrive,
  };
}
