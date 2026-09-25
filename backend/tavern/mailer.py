"""Outgoing email (password resets) over SMTP. Defaults suit Gmail with an
app password: smtp.gmail.com:587 with STARTTLS."""

from __future__ import annotations

import html
import logging
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

from .config import settings

log = logging.getLogger("tavern.mail")


def send_mail(to: str, subject: str, text: str, html_body: str) -> bool:
    if not settings.smtp_enabled:
        log.warning("SMTP isn't configured; not sending %r to %s", subject, to)
        return False

    msg = EmailMessage()
    msg["From"] = formataddr(("Tavern", settings.smtp_from or settings.smtp_user or ""))
    msg["To"] = to
    msg["Subject"] = subject
    msg["Message-ID"] = make_msgid(domain=(settings.smtp_from or "tavern.local").split("@")[-1])
    msg.set_content(text)
    msg.add_alternative(html_body, subtype="html")

    context = ssl.create_default_context()
    try:
        if settings.smtp_security == "ssl":
            server: smtplib.SMTP = smtplib.SMTP_SSL(settings.smtp_host or "", settings.smtp_port, timeout=20, context=context)
        else:
            server = smtplib.SMTP(settings.smtp_host or "", settings.smtp_port, timeout=20)
        with server:
            if settings.smtp_security == "starttls":
                server.starttls(context=context)
            server.login(settings.smtp_user or "", settings.smtp_password or "")
            server.send_message(msg)
        log.info("Sent %r to %s", subject, to)
        return True
    except Exception:
        log.exception("Failed to send %r to %s", subject, to)
        return False


def send_password_reset(to: str, name: str, link: str) -> None:
    """Runs as a background task after the request returns."""
    if not settings.smtp_enabled:
        # Handy for local testing or before email is set up: the admin can
        # copy the link out of the logs.
        log.warning("Password reset link for %s (SMTP not configured): %s", to, link)
        return

    safe_name = html.escape(name)
    safe_link = html.escape(link, quote=True)
    text = (
        f"Hey {name},\n\n"
        "Your Tavern password can be reset by opening the link below. "
        "It works once and expires in one hour.\n\n"
        f"{link}\n\n"
        "If you didn't ask for a new password, you can ignore this email.\n"
    )
    body = f"""\
<!doctype html>
<html><body style="margin:0;padding:0;background:#f2f3f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f3f5;padding:32px 0;">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:5px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#313338;">
      <tr><td style="background:#5865f2;border-radius:5px 5px 0 0;padding:20px 40px;color:#ffffff;font-size:22px;font-weight:700;">Tavern</td></tr>
      <tr><td style="padding:36px 40px 12px 40px;">
        <div style="font-size:20px;font-weight:600;color:#060607;margin-bottom:16px;">Hey {safe_name},</div>
        <div style="font-size:16px;line-height:24px;color:#4e5058;">Your Tavern password can be reset by clicking the button below. The link works once and expires in one hour.</div>
      </td></tr>
      <tr><td style="padding:20px 40px 28px 40px;">
        <a href="{safe_link}" style="display:inline-block;background:#5865f2;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:13px 24px;border-radius:3px;">Reset Password</a>
      </td></tr>
      <tr><td style="padding:0 40px 36px 40px;font-size:14px;line-height:20px;color:#6d6f78;">
        If you didn't ask for a new password, you can ignore this email. Your password won't change.
        <div style="margin-top:16px;word-break:break-all;">Button not working? Paste this into your browser:<br><a href="{safe_link}" style="color:#006ce7;">{safe_link}</a></div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>"""
    send_mail(to, "Reset your Tavern password", text, body)
