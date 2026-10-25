"""HTTPS that works out of the box on every machine.

Python from python.org on a Mac ships without trusted certificates until its "Install
Certificates.command" is run, so every outside call (GFW, OBIS, maps, Gemini) fails with
CERTIFICATE_VERIFY_FAILED. Importing this module makes urllib trust the system's certificates
plus certifi's (when installed) for the whole process.
"""
import os
import ssl
import urllib.request


def ssl_context():
    ctx = ssl.create_default_context()
    extra = ["/etc/ssl/cert.pem", "/usr/local/etc/openssl/cert.pem", "/opt/homebrew/etc/openssl@3/cert.pem"]
    try:
        import certifi
        extra.insert(0, certifi.where())
    except ImportError:
        pass
    for path in extra:
        if os.path.exists(path):
            try:
                ctx.load_verify_locations(path)
            except (ssl.SSLError, OSError):
                pass
    return ctx


urllib.request.install_opener(urllib.request.build_opener(urllib.request.HTTPSHandler(context=ssl_context())))


def explain(err, url=""):
    """A short, human reason for a failed request."""
    reason = getattr(err, "reason", err)
    text = str(reason)
    host = urllib.request.urlparse(url).hostname if url else "the service"
    if "CERTIFICATE_VERIFY_FAILED" in text:
        return (f"Couldn't verify {host}'s security certificate. On a Mac, open Applications > Python 3.x "
                "and run 'Install Certificates.command', then restart the server.")
    if isinstance(reason, TimeoutError) or "timed out" in text:
        return f"{host} took too long to answer. Try again in a moment."
    return f"Couldn't reach {host} ({text}). Check the internet connection."
