from pathlib import Path

from pydantic_settings import BaseSettings

# Application version - update this for each release
APP_VERSION = "0.1.1b2"

# GitHub repository for update checks
GITHUB_REPO = "maziggy/SpoolBuddy"


class Settings(BaseSettings):
    """Application settings with environment variable support."""

    # Server
    host: str = "0.0.0.0"
    port: int = 3000

    # Database
    database_path: Path = Path("spoolbuddy.db")

    # Static files (frontend)
    static_dir: Path = Path("../frontend/dist")

    # Project root (for git operations)
    project_root: Path = Path(__file__).parent.parent

    class Config:
        env_prefix = "SPOOLBUDDY_"


settings = Settings()
