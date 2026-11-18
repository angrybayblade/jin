// Another machine's task: its own route (not a rewrite of /t/<id>), so the browser's router
// treats the same task id on two machines as two pages and never reuses one for the other.
export { default } from "../../../../t/[taskId]/page";
export const dynamic = "force-dynamic";
