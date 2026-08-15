"""Regression tests for private service-to-worker configuration hints."""

import pickle
import unittest


try:
    from manga_translator.config import Config
except ImportError as error:  # pragma: no cover - minimal local environments
    Config = None
    _IMPORT_ERROR = error


@unittest.skipIf(Config is None, "configuration dependencies are unavailable")
class ConfigTransportFlagTests(unittest.TestCase):
    """Ensure untrusted JSON cannot set hints and worker pickle retains them."""

    def test_private_transport_flags_survive_worker_pickle(self) -> None:
        """The public process can safely communicate image fast-path intent."""
        config = Config()
        config._web_frontend_optimized = True
        config._image_result_only = True

        restored = pickle.loads(pickle.dumps(config))

        self.assertTrue(restored._web_frontend_optimized)
        self.assertTrue(restored._image_result_only)

    def test_transport_flags_are_not_accepted_from_json(self) -> None:
        """Client JSON fields cannot opt unrelated endpoints into minimal results."""
        config = Config.model_validate({
            "_web_frontend_optimized": True,
            "_image_result_only": True,
        })

        self.assertFalse(config._web_frontend_optimized)
        self.assertFalse(config._image_result_only)


if __name__ == "__main__":
    unittest.main()
