from datetime import datetime

from sqlalchemy import JSON, DateTime, Integer, String, Text, create_engine, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

from app.config import settings


def _url(url: str) -> str:
    # Coolify/Infisical provide postgresql://, SQLAlchemy needs the psycopg driver
    return url.replace("postgresql://", "postgresql+psycopg://", 1)


def make_engine(url: str):
    url = _url(url)
    if url.startswith("sqlite"):  # tests and local experiments
        return create_engine(
            url, connect_args={"check_same_thread": False, "timeout": 30}
        )
    return create_engine(
        url,
        pool_pre_ping=True,
        # PgBouncer in transaction mode does not support prepared statements
        connect_args={"prepare_threshold": None, "connect_timeout": 5},
    )


engine = make_engine(settings.database_url)
SessionLocal = sessionmaker(engine, expire_on_commit=False)

JSONType = JSON().with_variant(JSONB(), "postgresql")


class Base(DeclarativeBase):
    pass


class Dataset(Base):
    __tablename__ = "datasets"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(20), default="queued")
    error: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    summary: Mapped[dict | None] = mapped_column(JSONType, nullable=True)
    result: Mapped[dict | None] = mapped_column(JSONType, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Explanation(Base):
    """LLM explanations are cached per (dataset, finding content, model) so tokens are spent once.

    finding_key is a content hash, so it stays valid when a re-analysis renumbers findings.
    """

    __tablename__ = "explanations"

    dataset_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    finding_key: Mapped[str] = mapped_column(String(40), primary_key=True)
    model: Mapped[str] = mapped_column(String(120), primary_key=True)
    text: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ChatLog(Base):
    """Every chatbot question and answer, kept to improve the website later."""

    __tablename__ = "chat_logs"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    session: Mapped[str] = mapped_column(String(60), index=True)
    page: Mapped[str | None] = mapped_column(String(200), nullable=True)
    dataset_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    question: Mapped[str] = mapped_column(Text)
    answer: Mapped[str] = mapped_column(Text)
    model: Mapped[str | None] = mapped_column(String(120), nullable=True)
    ok: Mapped[bool] = mapped_column(default=True)
    helpful: Mapped[bool | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class FindingAck(Base):
    """Operator acknowledgement of a finding ("ack" = seen, "done" = fixed), shared by all viewers.

    Keyed by the finding's numeric id, which a re-analysis renumbers, so acks are dropped then.
    """

    __tablename__ = "finding_acks"

    dataset_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    finding_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    state: Mapped[str] = mapped_column(String(10))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
