// A minimal router: exact segments and :params, JSON in and out.

export type Params = Record<string, string>;
export type Handler = (req: Request, params: Params, url: URL) => Response | Promise<Response>;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const json = (body: unknown, status = 200) => Response.json(body, { status });

export async function body<T = any>(req: Request): Promise<T> {
  const text = await req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
}

export class Router {
  private routes: { method: string; parts: string[]; handler: Handler }[] = [];

  on(method: string, path: string, handler: Handler) {
    this.routes.push({ method, parts: path.split("/").filter(Boolean), handler });
    return this;
  }

  match(method: string, pathname: string): { handler: Handler; params: Params } | undefined {
    const parts = pathname.split("/").filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method || r.parts.length !== parts.length) continue;
      const params: Params = {};
      if (r.parts.every((p, i) => (p.startsWith(":") ? ((params[p.slice(1)] = decodeURIComponent(parts[i]!)), true) : p === parts[i]))) {
        return { handler: r.handler, params };
      }
    }
    return undefined;
  }
}
