import { useEffect, useState } from "react";
export function RestartCountdown({ until }: { until?: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const remaining = until
    ? Math.max(0, Math.ceil((new Date(until).getTime() - now) / 1000))
    : 0;
  if (!Number.isFinite(remaining) || remaining === 0)
    return <span>Скоро откроется</span>;
  return (
    <span>
      Откроется через {Math.floor(remaining / 60)}:
      {String(remaining % 60).padStart(2, "0")}
    </span>
  );
}
