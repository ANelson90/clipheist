/*
 * ClipHeist site configuration.
 *
 * youtubeClientId:
 *   OPTIONAL. Turns on "Upload directly to YouTube" in the export dialog.
 *   Create an OAuth 2.0 Client ID (type "Web application") in Google Cloud Console,
 *   enable the "YouTube Data API v3", and add your site's origin (e.g. https://clipheist.example)
 *   to "Authorized JavaScript origins". Paste the client ID below.
 *   Leave it empty to hide direct upload. Users can still post with the platform buttons.
 */
window.CLIPHEIST_CONFIG = {
  version: '1.0.0',
  youtubeClientId: '',            // e.g. '1234567890-abcdefg.apps.googleusercontent.com'
  youtubeCategoryId: '20',        // 20 = Gaming
  // AI Edit cloud writer (titles/captions). Points at the included Vercel function /api/ai.
  // Needs ANTHROPIC_API_KEY set on the server; otherwise AI Edit silently uses its on-device writer.
  // Set to '' to hide the cloud option entirely.
  aiEndpoint: '/api/ai',
  defaultHashtags: '#gaming #openworld #clips',
  suggestedHashtags: ['#gaming', '#openworld', '#clips', '#GTA6', '#GTAVI', '#gameplay', '#shorts', '#ps5', '#xboxseriesx', '#funnymoments', '#stunts', '#highlights', '#fyp']
};
