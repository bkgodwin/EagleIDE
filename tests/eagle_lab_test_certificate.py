"""Generate an ephemeral, test-only TLS identity for the local browser fixture."""
import datetime
import json
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Eagle Lab synthetic browser fixture")])
now = datetime.datetime.now(datetime.timezone.utc)
certificate = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
               .public_key(key.public_key()).serial_number(x509.random_serial_number())
               .not_valid_before(now - datetime.timedelta(minutes=1))
               .not_valid_after(now + datetime.timedelta(days=1))
               .add_extension(x509.SubjectAlternativeName([x509.DNSName("ide.school.test"), x509.DNSName("*.pve.school.test")]), critical=False)
               .sign(key, hashes.SHA256()))
print(json.dumps({
    "key": key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode(),
    "cert": certificate.public_bytes(serialization.Encoding.PEM).decode(),
}))
