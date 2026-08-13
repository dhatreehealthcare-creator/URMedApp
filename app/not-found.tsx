import { ArrowLeft, MapPinOff } from "lucide-react";
import Link from "next/link";

export default function NotFound() {
  return <main className="protected-route">
    <section className="protected-session">
      <div className="portal-panel">
        <div className="portal-panel-heading"><div><span className="portal-kicker">404</span><h1>Page not found</h1><p>The address may be incorrect or the page may no longer be available.</p></div><MapPinOff aria-hidden="true" size={24} /></div>
        <div className="portal-form-grid one"><Link className="portal-primary" href="/"><ArrowLeft size={16} /> Return to marketplace</Link></div>
      </div>
    </section>
  </main>;
}
