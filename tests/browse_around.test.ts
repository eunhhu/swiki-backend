import { describe, expect, it } from "bun:test";
import { GridMapService, type GridDocNode } from "../src/browse/grid";

const UPDATED_AT = "2024-01-01T00:00:00.000Z";

const createNode = (id: string, x: number, y: number, score: number): GridDocNode => ({
  id,
  title: id,
  x,
  y,
  score,
  words: 100,
  views: 0,
  updatedAt: UPDATED_AT,
  emb: [],
});

const buildGrid = () => {
  const grid = new GridMapService({ ttlMs: 60_000, minCoreRadius: 0, placement: "nearest", persistPath: null });
  const docsById = (grid as any).docsById as Map<string, GridDocNode>;
  docsById.clear();
  const nodes = [
    createNode("a", 0, 0, 5),
    createNode("b", 10, 0, 2),
    createNode("c", 0, 10, 3),
    createNode("d", 5, 5, 4),
    createNode("e", 20, 20, 1),
  ];
  for (const node of nodes) {
    docsById.set(node.id, node);
  }
  (grid as any).lastAccess = new Map<string, number>();
  return grid;
};

describe("GridMapService.getAroundCoord", () => {
  it("returns the nearest nodes ordered by distance and score", () => {
    const grid = buildGrid();
    const result = grid.getAroundCoord(0, 0, 4);
    expect(result.map((n) => n.id)).toEqual(["a", "d", "c", "b"]);
  });

  it("clamps the requested count to the available nodes and updates access timestamps", () => {
    const grid = buildGrid();
    const result = grid.getAroundCoord(100, 0, 9);
    expect(result.length).toBe(5);
    const lastAccess = (grid as any).lastAccess as Map<string, number>;
    for (const node of result) {
      const value = lastAccess.get(node.id) ?? 0;
      expect(value).toBeGreaterThan(0);
    }
  });
});
