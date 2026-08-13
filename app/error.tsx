"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";

export default function ApplicationError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="protected-route">
    <section className="protected-session">
      <div className="portal-panel" role="alert">
        <div className="portal-panel-heading"><div><span className="portal-kicker">URMED</span><h1>Something went wrong</h1><p>The requested screen could not be displayed. Your submitted information has not been repeated automatically.</p></div><AlertTriangle size={24} /></div>
        <div className="portal-form-grid one"><button className="portal-primary" onClick={reset} type="button"><RefreshCw size={16} /> Try again</button></div>
      </div>
    </section>
  </main>;
}
