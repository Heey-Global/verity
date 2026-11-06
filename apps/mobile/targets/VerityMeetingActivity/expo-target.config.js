// ActivityKit renders the same status on iPhone and the iPad Lock Screen.
/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: 'widget',
  name: 'VerityMeetingActivity',
  displayName: 'Verity Meeting',
  bundleIdentifier: '.meetingactivity',
  deploymentTarget: '27.0',
  frameworks: ['ActivityKit', 'AppIntents', 'SwiftUI', 'WidgetKit'],
};
