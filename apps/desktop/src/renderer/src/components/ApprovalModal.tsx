import type { ApprovalOutcome, ApprovalRequest } from "@cozycode/protocol";

interface Props {
  request: ApprovalRequest;
  onRespond: (outcome: ApprovalOutcome) => void;
}

export function ApprovalModal({ request, onRespond }: Props) {
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>Approve action?</h3>
        <p className="tool-name">{request.toolName}</p>
        <p className="summary">{request.summary}</p>
        <pre className="args">{JSON.stringify(request.args, null, 2)}</pre>
        <div className="row end">
          <button type="button" onClick={() => onRespond("deny")}>
            Deny
          </button>
          <button type="button" onClick={() => onRespond("allow-session")}>
            Always allow
          </button>
          <button type="button" className="primary" onClick={() => onRespond("allow-once")}>
            Allow once
          </button>
        </div>
      </div>
    </div>
  );
}
