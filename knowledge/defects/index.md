# Defect

* [A config apiKey hid every stored key of its provider, and a removed key stayed listed](a-config-api-key-hid-every-stored-key-of-its-provider.md) - On omp 18.2.11 with ccw's commits, a models.yml apiKey made every stored API key of that provider inert and refused a session pin, even when the env var it names was unset. Remove on a disabled row did nothing, a removed row stayed listed with an Enable action, and omp token --list failed for API keys. Fixed on ccw and ccw-next with the same two commit subjects.
