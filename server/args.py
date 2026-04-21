from __future__ import annotations

import argparse
import os
from argparse import ArgumentParser, Namespace
from urllib.parse import unquote


def url_decode(value: str) -> str:
    """Decode CLI paths.

    Args:
        value: Raw CLI value that may contain URL encoded characters.

    Returns:
        The decoded filesystem path.
    """
    s = value
    s = unquote(s)
    if s.startswith('file:///'):
        s = s[len('file://'):]
    return s

# Additional argparse types


def path(string: str) -> str:
    """Validate a filesystem path.

    Args:
        string: Raw CLI argument.

    Returns:
        The normalized path string.

    Raises:
        argparse.ArgumentTypeError: Raised when the target path does not exist.
    """
    if not string:
        return ''
    s = url_decode(os.path.expanduser(string))
    if not os.path.exists(s):
        raise argparse.ArgumentTypeError(f'No such file or directory: "{string}"')
    return s


def file_path(string: str) -> str:
    """Validate a file path.

    Args:
        string: Raw CLI argument.

    Returns:
        The normalized file path string.

    Raises:
        argparse.ArgumentTypeError: Raised when the target file does not exist.
    """
    if not string:
        return ''
    s = url_decode(os.path.expanduser(string))
    if not os.path.exists(s):
        raise argparse.ArgumentTypeError(f'No such file: "{string}"')
    return s


def dir_path(string: str) -> str:
    """Validate a directory path.

    Args:
        string: Raw CLI argument.

    Returns:
        The normalized directory path string.

    Raises:
        argparse.ArgumentTypeError: Raised when the target directory does not exist.
    """
    if not string:
        return ''
    s = url_decode(os.path.expanduser(string))
    if not os.path.exists(s):
        raise argparse.ArgumentTypeError(f'No such directory: "{string}"')
    return s


def positive_int(value: str) -> int:
    """Validate a positive integer CLI argument.

    Args:
        value: Raw CLI value.

    Returns:
        The parsed positive integer.

    Raises:
        argparse.ArgumentTypeError: Raised when the value is not a positive integer.
    """
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("Value must be greater than or equal to 1")
    return parsed


def parse_arguments() -> Namespace:
    """Parse CLI arguments for the FastAPI server.

    Returns:
        The parsed CLI namespace.
    """
    parser: ArgumentParser = argparse.ArgumentParser(
        description="Specify host and port for the server."
    )
    parser.add_argument('--host', type=str, default='127.0.0.1', help='The host address (default: 127.0.0.1)')
    parser.add_argument('--port', type=int, default=8000, help='The port number (default: 8080)')
    parser.add_argument('-v', '--verbose', action='store_true',
                        help='Print debug info and save intermediate images in result folder')
    parser.add_argument('--start-instance', action='store_true',
                        help='If a translator should be launched automatically')
    parser.add_argument('--instances', default=1, type=positive_int,
                        help='Number of internal translator worker instances to launch (default: 1)')
    parser.add_argument('--ignore-errors', action='store_true', help='Skip image on encountered error.')
    parser.add_argument('--nonce', default=os.getenv('MT_WEB_NONCE') or None, type=str, help='Nonce for securing internal web server communication, set to "None" to disable')
    parser.add_argument('--api-key', default=None, type=str, help='Optional API key used to protect public endpoints')
    parser.add_argument('--models-ttl', default='0', type=int, help='models TTL in memory in seconds')
    parser.add_argument('--pre-dict', default=None, type=file_path, help='Path to the pre-translation dictionary file')
    parser.add_argument('--post-dict', default=None, type=file_path, help='Path to the post-translation dictionary file')    
    g = parser.add_mutually_exclusive_group()
    g.add_argument('--use-gpu', action='store_true', help='Turn on/off gpu (auto switch between mps and cuda)')
    g.add_argument('--use-gpu-limited', action='store_true', help='Turn on/off gpu (excluding offline translator)')
    return parser.parse_args()
