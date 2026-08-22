"use client";

export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="login-page">
      <section className="login-card" role="alert">
        <span className="eyebrow">Mission Control error</span>
        <h1>The control surface could not render.</h1>
        <p>{error.message || "An unexpected client error occurred."}</p>
        <button onClick={reset}>Retry</button>
      </section>
    </main>
  );
}
