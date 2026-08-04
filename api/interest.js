/**
 * POST /api/interest — beta interest form handler for the MyCollegeCounsel
 * placeholder site.
 *
 * Emails each submission to the owner via Resend (collegecounsel.app is a
 * verified sending domain). Zero npm dependencies: uses global fetch, so the
 * project needs no package.json or node_modules.
 *
 * Required env var on the Vercel project: RESEND_API_KEY
 * Optional:  INTEREST_TO   (defaults to ahmed@collegecounsel.app)
 *            INTEREST_FROM (defaults to "MyCollegeCounsel Beta <beta@collegecounsel.app>")
 *
 * Data minimisation is deliberate: name, email, role, optional graduating
 * class, optional note. Nothing else is collected, stored, or logged — many
 * of these submitters are minors.
 */

const TO = process.env.INTEREST_TO || "ahmed@collegecounsel.app";
const FROM = process.env.INTEREST_FROM || "MyCollegeCounsel Beta <beta@collegecounsel.app>";

const ROLES = {
  student: "Student",
  parent: "Parent or guardian",
  counselor: "School counselor",
  other: "Other",
};

const LIMITS = { name: 80, email: 254, gradYear: 8, note: 1000 };

/** Conservative email check — deliberately permissive, we only reject obvious junk. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Strip CR/LF so nothing can be injected into the subject header. */
function oneLine(s) {
  return String(s).replace(/[\r\n]+/g, " ").trim();
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function validate(body) {
  const name = oneLine(body.name || "").slice(0, LIMITS.name);
  const email = oneLine(body.email || "").slice(0, LIMITS.email);
  const roleKey = oneLine(body.role || "").toLowerCase();
  const gradYear = oneLine(body.gradYear || "").slice(0, LIMITS.gradYear);
  const note = String(body.note || "").slice(0, LIMITS.note).trim();

  if (!name) return { error: "Please tell us your name." };
  if (!email || !EMAIL_RE.test(email)) return { error: "Please enter a valid email address." };
  if (!ROLES[roleKey]) return { error: "Please tell us who you are." };

  return { data: { name, email, role: ROLES[roleKey], gradYear, note } };
}

function buildEmail(d) {
  const rows = [
    ["Name", d.name],
    ["Email", d.email],
    ["They are a", d.role],
    ["Graduating class", d.gradYear || "—"],
  ];

  const text =
    rows.map(([k, v]) => `${k}: ${v}`).join("\n") +
    (d.note ? `\n\nNote:\n${d.note}` : "") +
    `\n\n— Sent by the beta interest form at https://collegecounsel.app`;

  const html = `<div style="font-family:ui-sans-serif,system-ui,'Segoe UI',Roboto,sans-serif;color:#0f172a;line-height:1.6">
  <h2 style="margin:0 0 12px;font-size:18px;color:#4338ca">New beta interest</h2>
  <table cellpadding="0" cellspacing="0" style="font-size:14px;border-collapse:collapse">
    ${rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:4px 16px 4px 0;color:#475569;vertical-align:top">${esc(k)}</td><td style="padding:4px 0"><strong>${esc(v)}</strong></td></tr>`,
      )
      .join("")}
  </table>
  ${
    d.note
      ? `<p style="margin:16px 0 4px;color:#475569;font-size:14px">Note</p>
         <blockquote style="margin:0;padding:8px 12px;border-left:3px solid #e0e7ff;color:#0f172a;font-size:14px;white-space:pre-wrap">${esc(d.note)}</blockquote>`
      : ""
  }
  <p style="margin-top:20px;font-size:12px;color:#64748b">Reply to this email to answer ${esc(d.name)} directly.<br>Sent by the beta interest form at collegecounsel.app</p>
</div>`;

  return { text, html };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }

  const body = await readBody(req);
  if (!body) return res.status(400).json({ ok: false, error: "Malformed request." });

  // Honeypot: real people never fill this. Answer 200 so bots learn nothing.
  if (oneLine(body.website || "")) return res.status(200).json({ ok: true });

  const { data, error } = validate(body);
  if (error) return res.status(400).json({ ok: false, error });

  if (!process.env.RESEND_API_KEY) {
    console.error("interest: RESEND_API_KEY is not set on this deployment");
    return res.status(503).json({
      ok: false,
      error: "Our signup form isn't available right now — please email support@collegecounsel.app.",
    });
  }

  const { text, html } = buildEmail(data);

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [TO],
        reply_to: data.email,
        subject: `Beta interest — ${data.name} (${data.role})`,
        text,
        html,
      }),
    });

    if (!r.ok) {
      // Log status only; never log the submitter's details.
      console.error("interest: resend responded", r.status, await r.text().catch(() => ""));
      return res.status(502).json({
        ok: false,
        error: "We couldn't send that just now — please email support@collegecounsel.app.",
      });
    }
  } catch (err) {
    console.error("interest: send failed", err && err.message);
    return res.status(502).json({
      ok: false,
      error: "We couldn't send that just now — please email support@collegecounsel.app.",
    });
  }

  return res.status(200).json({ ok: true });
};

// Exported for local tests only.
module.exports._internals = { validate, buildEmail, esc, oneLine, ROLES, LIMITS };
