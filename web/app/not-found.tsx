import Link from "next/link";

export default function NotFound() {
  return (
    <main className="screen">
      <h1>There is nothing here</h1>
      <Link className="button" href="/">
        Go to the start
      </Link>
    </main>
  );
}
