import { Missing } from "@/components/Missing";

/** A page that is not there (an old link, a removed doc). */
export default function NotFound() {
  return <Missing title="Not here" body="It may have been removed, or it lives on another machine." />;
}
