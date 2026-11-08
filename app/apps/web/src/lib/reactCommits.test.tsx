// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

describe("React's commits, as the watchdog hears them", () => {
  it("names the components each commit rendered", async () => {
    // The hook goes in before React loads, as main.tsx does.
    const { lastCommits } = await import("./reactCommits");
    const { act, memo, useState } = await import("react");
    const { createRoot } = await import("react-dom/client");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let bump = () => {};
    const Row = memo(function Row({ n }: { n: number }) {
      return <li>{n}</li>;
    });
    function List() {
      const [count, setCount] = useState(1);
      bump = () => setCount((value) => value + 1);
      return <ul>{[0, 1, 2].map((index) => <Row key={index} n={index === 0 ? count : index} />)}</ul>;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(<List />));
    act(() => bump());
    expect(lastCommits().at(-1)?.names).toEqual(["List", "Row"]);
    act(() => root.unmount());
  });
});
