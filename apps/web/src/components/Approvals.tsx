import { decideApproval } from "@/app/actions";
import type { Approval } from "@/lib/daemon";
import { ActionMark } from "./ThermalMark";

/** "`git push` pushes to a remote" -> "Pushes to a remote": the command is shown on its own line. */
function title(a: Approval): string {
  const why = a.reason.replace(/^`[^`]*`\s*/, "").trim() || a.reason;
  return why.charAt(0).toUpperCase() + why.slice(1);
}

function describe(a: Approval): string {
  const input = a.action.input;
  if (typeof input.command === "string") return input.command;
  return `${a.action.tool} ${JSON.stringify(input)}`;
}

/**
 * Pending decisions, one compact row each (Zero's approval pattern in the page's
 * content flow): action mark, title, the exact action, decision controls.
 */
export function Approvals({ approvals }: { approvals: Approval[] }) {
  if (!approvals.length) return null;
  return (
    <section className="approvals" aria-labelledby="approvals-heading">
      <div className="section-label" id="approvals-heading">
        Approvals <span className="count">{approvals.length}</span>
      </div>
      <ul className="approval-list">
        {approvals.map((a) => (
          <li key={a.id} className="approval-row" data-approval-id={a.id}>
            <ActionMark tool={a.action.tool} />
            <div className="approval-body">
              <div className="approval-title">{title(a)}</div>
              <code className="approval-command">{describe(a)}</code>
            </div>
            <form action={decideApproval} className="approval-actions">
              <input type="hidden" name="approvalId" value={a.id} />
              <button type="submit" name="decision" value="reject" data-decision="reject" className="button quiet">
                Decline
              </button>
              <button type="submit" name="decision" value="approve" data-decision="approve" className="button primary">
                Approve
              </button>
            </form>
          </li>
        ))}
      </ul>
    </section>
  );
}
