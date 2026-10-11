"""
notifier.py — Notification Simulation for Construction Quality Control

Provides a pluggable notification system. The current implementation
simulates sending notifications (prints to console / returns a message).
The architecture allows swapping in real notification channels (SMTP email,
Twilio SMS, webhook) by subclassing the Notifier base class.

Usage:
    notifier = SimulatedNotifier()
    message = notifier.send(
        defect_type="rusted_rebar",
        severity="High",
        image_name="site_photo.jpg",
    )
"""

from abc import ABC, abstractmethod
from datetime import datetime, timezone


class Notifier(ABC):
    """
    Abstract base class for defect-violation notifiers.

    Subclass this to implement real notification channels.
    """

    @abstractmethod
    def send(
        self,
        defect_type: str,
        severity: str,
        image_name: str,
        details: str = "",
    ) -> str:
        """
        Send a violation notification.

        Parameters
        ----------
        defect_type : str
            The type of defect ('rusted_rebar' or 'honeycombed_concrete').
        severity : str
            The severity level ('Low', 'Medium', 'High', 'Critical').
        image_name : str
            The filename of the analyzed image.
        details : str, optional
            Additional details about the defect.

        Returns
        -------
        str
            A confirmation message describing what was sent.
        """
        ...


class SimulatedNotifier(Notifier):
    """
    Simulated notifier — logs to console, returns a confirmation string.

    This is the POC implementation. No real messages are sent.
    """

    def send(
        self,
        defect_type: str,
        severity: str,
        image_name: str,
        details: str = "",
    ) -> str:
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        defect_display = defect_type.replace("_", " ").title()

        message = (
            f"VIOLATION NOTIFICATION\n"
            f"  Time:     {timestamp}\n"
            f"  Image:    {image_name}\n"
            f"  Defect:   {defect_display}\n"
            f"  Severity: {severity}\n"
        )
        if details:
            message += f"  Details:  {details}\n"

        message += "  Status:   Notification sent to site supervisor"

        # Use ASCII for console (Windows cp1252 safe); Streamlit UI
        # will add its own emoji formatting.
        print(f"[notifier] [ALERT] {message}")
        return message


# ---------------------------------------------------------------------------
# Placeholder stubs for future real implementations
# ---------------------------------------------------------------------------

class EmailNotifier(Notifier):
    """
    Placeholder for SMTP email notifications.

    To implement:
        1. Configure SMTP settings (host, port, credentials).
        2. Build an HTML email template with defect details.
        3. Send via smtplib or a library like yagmail.
    """

    def __init__(self, smtp_host: str = "", smtp_port: int = 587,
                 sender: str = "", password: str = "", recipient: str = ""):
        self.smtp_host = smtp_host
        self.smtp_port = smtp_port
        self.sender = sender
        self.password = password
        self.recipient = recipient

    def send(self, defect_type: str, severity: str, image_name: str,
             details: str = "") -> str:
        raise NotImplementedError(
            "EmailNotifier is a placeholder. Configure SMTP settings and "
            "implement the send method for production use."
        )


class SMSNotifier(Notifier):
    """
    Placeholder for Twilio SMS notifications.

    To implement:
        1. Install twilio: pip install twilio
        2. Configure account SID, auth token, and phone numbers.
        3. Send SMS via twilio.rest.Client.
    """

    def __init__(self, account_sid: str = "", auth_token: str = "",
                 from_number: str = "", to_number: str = ""):
        self.account_sid = account_sid
        self.auth_token = auth_token
        self.from_number = from_number
        self.to_number = to_number

    def send(self, defect_type: str, severity: str, image_name: str,
             details: str = "") -> str:
        raise NotImplementedError(
            "SMSNotifier is a placeholder. Configure Twilio credentials and "
            "implement the send method for production use."
        )


# ---------------------------------------------------------------------------
# CLI test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    notifier = SimulatedNotifier()
    msg = notifier.send(
        defect_type="rusted_rebar",
        severity="High",
        image_name="test_image.jpg",
        details="Rust coverage: 45%, ROI at (100, 200, 300, 400)",
    )
    print(f"\n[test] Returned message:\n{msg}")
