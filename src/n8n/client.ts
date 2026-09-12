export interface N8nNode {
  id?: string;
  name: string;
  type: string;
  typeVersion?: number;
  position?: number[];
  parameters: Record<string, unknown>;
  disabled?: boolean;
  credentials?: Record<string, unknown>;
  webhookId?: string;
  [key: string]: unknown;
}

export interface N8nWorkflow {
  id?: string;
  name: string;
  nodes: N8nNode[];
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
  versionId?: string;
  active?: boolean;
  staticData?: unknown;
  pinData?: Record<string, unknown> | null;
  nodeGroups?: unknown[];
  description?: string;
  [key: string]: unknown;
}

export interface N8nExecution {
  id: string | number;
  workflowId?: string | number;
  finished?: boolean;
  status?: string;
  mode?: string;
  startedAt?: string;
  stoppedAt?: string | null;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export class N8nApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'N8nApiError';
  }
}

function apiBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  const url = new URL(trimmed);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('N8N_BASE_URL must use http or https.');
  }
  const base = url.toString().replace(/\/+$/, '');
  return base.endsWith('/api/v1') ? base : `${base}/api/v1`;
}

async function responseBody(response: Response): Promise<unknown> {
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('application/json')) return response.json();
  return response.text();
}

export class N8nClient {
  private readonly baseUrl: string;
  readonly instanceUrl: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
  ) {
    if (!baseUrl.trim()) throw new Error('N8N_BASE_URL is not configured.');
    if (!apiKey.trim()) throw new Error('N8N_API_KEY is not configured.');
    this.baseUrl = apiBaseUrl(baseUrl);
    this.instanceUrl = this.baseUrl.replace(/\/api\/v1$/, '');
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-N8N-API-KEY': this.apiKey,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await responseBody(response);
    if (!response.ok) {
      const detail =
        payload && typeof payload === 'object' && 'message' in payload
          ? String((payload as { message?: unknown }).message)
          : String(payload || response.statusText);
      throw new N8nApiError(response.status, `n8n API request failed: ${detail}`, payload);
    }
    return payload as T;
  }

  getWorkflow(workflowId: string): Promise<N8nWorkflow> {
    return this.request('GET', `/workflows/${encodeURIComponent(workflowId)}`);
  }

  createWorkflow(workflow: N8nWorkflow): Promise<N8nWorkflow> {
    return this.request('POST', '/workflows', workflowUpdatePayload(workflow));
  }

  /** Page through every workflow. Used to find leftover test clones. */
  async listWorkflows(): Promise<N8nWorkflow[]> {
    const all: N8nWorkflow[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ limit: '100' });
      if (cursor) query.set('cursor', cursor);
      const page = await this.request<{ data?: N8nWorkflow[]; nextCursor?: string } | N8nWorkflow[]>(
        'GET',
        `/workflows?${query}`,
      );
      if (Array.isArray(page)) {
        all.push(...page);
        cursor = undefined;
      } else {
        all.push(...(page.data ?? []));
        cursor = page.nextCursor || undefined;
      }
    } while (cursor && all.length < 1000);
    return all;
  }

  updateWorkflow(
    workflowId: string,
    workflow: N8nWorkflow,
    publishIfActive: boolean | null = false,
  ): Promise<N8nWorkflow> {
    const query =
      publishIfActive === null ? '' : `?publishIfActive=${publishIfActive ? 'true' : 'false'}`;
    return this.request(
      'PUT',
      `/workflows/${encodeURIComponent(workflowId)}${query}`,
      workflowUpdatePayload(workflow),
    );
  }

  publishWorkflow(workflowId: string, versionId?: string): Promise<N8nWorkflow> {
    return this.request(
      'POST',
      `/workflows/${encodeURIComponent(workflowId)}/activate`,
      versionId ? { versionId } : {},
    );
  }

  unpublishWorkflow(workflowId: string): Promise<N8nWorkflow> {
    return this.request('POST', `/workflows/${encodeURIComponent(workflowId)}/deactivate`, {});
  }

  deleteWorkflow(workflowId: string): Promise<N8nWorkflow> {
    return this.request('DELETE', `/workflows/${encodeURIComponent(workflowId)}`);
  }

  async listExecutions(workflowId: string, includeData = true): Promise<N8nExecution[]> {
    const query = new URLSearchParams({
      workflowId,
      includeData: includeData ? 'true' : 'false',
      limit: '20',
    });
    const response = await this.request<N8nExecution[] | { data?: N8nExecution[] }>(
      'GET',
      `/executions?${query}`,
    );
    return Array.isArray(response) ? response : (response.data ?? []);
  }
}

/** Keep only fields accepted by n8n's public workflow update schema. */
export function workflowUpdatePayload(workflow: N8nWorkflow): N8nWorkflow {
  return {
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    // GET responses can contain version-dependent derived settings that an
    // older instance rejects on POST/PUT. Keep the stable public-API fields.
    settings: workflowSettingsPayload(workflow.settings),
    ...(typeof workflow.description === 'string' ? { description: workflow.description } : {}),
    ...(workflow.staticData === undefined ? {} : { staticData: workflow.staticData }),
    // pinData is absent from older public API schemas. This wrapper never
    // mutates pinned test data, so omit it for cross-version compatibility.
    ...(workflow.nodeGroups === undefined ? {} : { nodeGroups: workflow.nodeGroups }),
  };
}

function workflowSettingsPayload(
  settings: Record<string, unknown> | undefined,
): Record<string, unknown> {
  // An agent-authored definition may legitimately omit settings entirely.
  const source = settings ?? {};
  const allowed = [
    'saveExecutionProgress',
    'saveManualExecutions',
    'saveDataErrorExecution',
    'saveDataSuccessExecution',
    'executionTimeout',
    'errorWorkflow',
    'timezone',
    'executionOrder',
  ] as const;
  return Object.fromEntries(
    allowed.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
}
