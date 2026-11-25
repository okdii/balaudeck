// Routes ER diagram links off the UI thread (a big schema can take seconds).
// In:  { id, ps, boxes, style }   Out: { id, progress: [done, total] } … then { id, d }
import { pathsWithJumps, routeLinks, type Box, type edgePath, type LineStyle } from "./erLayout";

type Job = { id: number; ps: ReturnType<typeof edgePath>[]; boxes: Box[]; style: LineStyle };

self.onmessage = (ev: MessageEvent<Job>) => {
  const { id, ps, boxes, style } = ev.data;
  const polys = routeLinks(ps, boxes, style, (done, total) => self.postMessage({ id, progress: [done, total] }));
  self.postMessage({ id, progress: [ps.length, ps.length], jumping: true });
  const d = pathsWithJumps(polys);
  self.postMessage({ id, d });
};
