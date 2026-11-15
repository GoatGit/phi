import { describe, expect, it } from "vitest";
import { releaseStuckPointerLock } from "@/lib/modalPointerLock";

function lockBody() {
  document.body.style.pointerEvents = "none";
}

function unlockBody() {
  document.body.style.removeProperty("pointer-events");
}

function mount(html: string) {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return () => host.remove();
}

describe("releaseStuckPointerLock", () => {
  it("body 没被锁时不动它", () => {
    unlockBody();
    expect(releaseStuckPointerLock()).toBe(false);
    expect(document.body.style.pointerEvents).toBe("");
  });

  it("模态层都卸载了、body 还锁着：解开来", () => {
    lockBody();
    expect(releaseStuckPointerLock()).toBe(true);
    expect(document.body.style.pointerEvents).toBe("");
    unlockBody();
  });

  it("还开着抽屉时不误解锁", () => {
    lockBody();
    const cleanup = mount(
      '<div role="dialog" data-state="open"><button>ok</button></div>',
    );
    expect(releaseStuckPointerLock()).toBe(false);
    expect(document.body.style.pointerEvents).toBe("none");
    cleanup();
    unlockBody();
  });

  it("还开着菜单时不误解锁", () => {
    lockBody();
    const cleanup = mount('<div role="menu" data-state="open"></div>');
    expect(releaseStuckPointerLock()).toBe(false);
    cleanup();
    unlockBody();
  });

  it("节点还在但已关闭（data-state=closed）不掉锁", () => {
    lockBody();
    const cleanup = mount('<div role="dialog" data-state="closed"></div>');
    expect(releaseStuckPointerLock()).toBe(true);
    cleanup();
    unlockBody();
  });
});
