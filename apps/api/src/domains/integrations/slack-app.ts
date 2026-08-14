/**
 * Slack app creation via the Manifest API – the "one button" setup.
 *
 * GitHub gives us a browser manifest flow; Slack's equivalent is
 * `apps.manifest.create`: the admin pastes an app configuration token
 * (api.slack.com/apps → "Your App Configuration Tokens" → Generate) and we
 * create the app server-side with this instance's URLs baked in. Slack answers
 * with ALL credentials (client id, client secret, signing secret) in one
 * response – nobody copies a secret by hand, and the slash-command/redirect
 * URLs can never be mistyped.
 */
import { env } from '../../env';
import { slackCallbackUrl } from './oauth';

/** The inbound slash-command endpoint the manifest registers. */
export function slackCommandsUrl(): string {
  return `${env.apiUrl}/api/v1/integrations/slack/commands`;
}

/**
 * The app manifest Slack turns into a real app. Mirrors the copyable manifest
 * shown in the settings UI: bot + /ordi slash command + OAuth redirect. No
 * event subscriptions on purpose – Slack verifies that URL at save time,
 * before the signing secret could possibly be stored.
 */
export function buildSlackManifest(workspaceName: string): Record<string, unknown> {
  const name = `ordi (${workspaceName})`.slice(0, 35);
  return {
    display_information: { name, description: 'Notifications and intake from ordi' },
    features: {
      bot_user: { display_name: 'ordi', always_online: true },
      slash_commands: [{
        command: '/ordi',
        url: slackCommandsUrl(),
        description: "File a request to this channel's project",
        usage_hint: '[request text]',
        should_escape: false,
      }],
    },
    oauth_config: {
      redirect_urls: [slackCallbackUrl()],
      scopes: { bot: ['channels:read', 'groups:read', 'chat:write', 'commands'] },
    },
    settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
  };
}

export interface SlackAppCreation {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
}

export class SlackManifestError extends Error {
  constructor(public code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** Create the app from the manifest; returns its full credentials. */
export async function createSlackApp(configToken: string, workspaceName: string): Promise<SlackAppCreation> {
  const res = await fetch('https://slack.com/api/apps.manifest.create', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${configToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ manifest: JSON.stringify(buildSlackManifest(workspaceName)) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new SlackManifestError('http_error', String(res.status));
  const data = (await res.json()) as {
    ok?: boolean;
    error?: string;
    errors?: Array<{ message?: string; pointer?: string }>;
    app_id?: string;
    credentials?: { client_id?: string; client_secret?: string; signing_secret?: string };
  };
  if (!data.ok) {
    const detail = data.errors?.map((e) => e.message).filter(Boolean).join('; ');
    throw new SlackManifestError(data.error ?? 'unknown_error', detail || undefined);
  }
  const creds = data.credentials;
  if (!data.app_id || !creds?.client_id || !creds.client_secret || !creds.signing_secret) {
    throw new SlackManifestError('missing_credentials');
  }
  return {
    appId: data.app_id,
    clientId: creds.client_id,
    clientSecret: creds.client_secret,
    signingSecret: creds.signing_secret,
  };
}
