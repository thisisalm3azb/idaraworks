import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

/**
 * The homepage's social preview, drawn from the same headline the page shows,
 * on the page's own palette. Rendered on this origin from a font that ships
 * in the repository (public/fonts), so nothing is fetched from elsewhere.
 */
export const alt = "IdaraWorks: run the business, not after it";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage() {
  const font = await readFile(join(process.cwd(), "public", "fonts", "NotoSans-Bold.ttf"));
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "64px 72px",
        background: "#f7f8f2",
        color: "#152c28",
        fontFamily: "Noto Sans",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 34 }}>
        <svg viewBox="0 0 36 40" width="44" height="49">
          <path d="M18 1 22 14 35 20 22 24 18 39 13 26 1 20 13 15Z" fill="#315b4e" />
          <path d="m18 9 2 10 9 1-10 3-1 9-3-11-7-1 9-3Z" fill="#d9f5a3" />
        </svg>
        IdaraWorks
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", flexDirection: "column", fontSize: 92, lineHeight: 1.02 }}>
          <span>Run the business.</span>
          <span style={{ color: "#608048" }}>Not after it.</span>
        </div>
        <div style={{ fontSize: 30, color: "#65716b", maxWidth: 900 }}>
          Work, people and finances in one workspace, with your name on the app.
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          fontSize: 24,
          color: "#2e5236",
        }}
      >
        <span style={{ background: "#d9f5a3", borderRadius: 8, padding: "10px 18px" }}>
          30 days free
        </span>
        <span>No credit card required</span>
      </div>
    </div>,
    { ...size, fonts: [{ name: "Noto Sans", data: font, weight: 700, style: "normal" }] },
  );
}
