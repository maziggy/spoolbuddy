from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional

from db import get_db
from models import Spool, SpoolCreate, SpoolUpdate


class SetWeightRequest(BaseModel):
    """Request to set spool weight from scale."""
    weight: int  # Current weight in grams (including core)


class LogUsageRequest(BaseModel):
    """Request to manually log filament usage."""
    weight_used: float  # Grams consumed
    print_name: Optional[str] = None
    printer_serial: Optional[str] = None


class KProfileInput(BaseModel):
    """K-profile to associate with a spool."""
    printer_serial: str
    extruder: Optional[int] = None
    nozzle_diameter: Optional[str] = None
    nozzle_type: Optional[str] = None
    k_value: str
    name: Optional[str] = None
    cali_idx: Optional[int] = None
    setting_id: Optional[str] = None


class SaveKProfilesRequest(BaseModel):
    """Request to save K-profiles for a spool."""
    profiles: list[KProfileInput]


class LinkTagRequest(BaseModel):
    """Request to link an NFC tag to an existing spool."""
    tag_id: str  # Base64-encoded NFC UID (or hex string)
    tag_type: Optional[str] = None  # e.g., "bambu", "generic", "unknown"
    data_origin: Optional[str] = None  # e.g., "nfc_link"


router = APIRouter(prefix="/spools", tags=["spools"])


@router.get("", response_model=list[Spool])
async def list_spools():
    """Get all spools."""
    db = await get_db()
    return await db.get_spools()


@router.get("/untagged", response_model=list[Spool])
async def list_untagged_spools():
    """Get all spools without an NFC tag assigned.

    Use this to find spools that can be linked to a new tag.
    Returns spools where tag_id is NULL or empty string.
    """
    db = await get_db()
    return await db.get_untagged_spools()


@router.get("/{spool_id}", response_model=Spool)
async def get_spool(spool_id: str):
    """Get a single spool."""
    db = await get_db()
    spool = await db.get_spool(spool_id)
    if not spool:
        raise HTTPException(status_code=404, detail="Spool not found")
    return spool


@router.post("", response_model=Spool, status_code=201)
async def create_spool(spool: SpoolCreate):
    """Create a new spool."""
    db = await get_db()
    return await db.create_spool(spool)


@router.put("/{spool_id}", response_model=Spool)
async def update_spool(spool_id: str, spool: SpoolUpdate):
    """Update an existing spool."""
    db = await get_db()
    updated = await db.update_spool(spool_id, spool)
    if not updated:
        raise HTTPException(status_code=404, detail="Spool not found")
    return updated


@router.delete("/{spool_id}", status_code=204)
async def delete_spool(spool_id: str):
    """Delete a spool."""
    db = await get_db()
    if not await db.delete_spool(spool_id):
        raise HTTPException(status_code=404, detail="Spool not found")


@router.patch("/{spool_id}/link-tag", response_model=Spool)
async def link_tag_to_spool(spool_id: str, request: LinkTagRequest):
    """Link an NFC tag to an existing spool.

    Use this to associate a tag_id with a spool that was created without one
    (e.g., via web frontend). This is useful when users want to tag existing
    spools in their inventory.

    Returns:
        Updated spool with tag_id set

    Raises:
        404: Spool not found
        409: Tag is already assigned to another spool
    """
    db = await get_db()

    # Check if spool exists
    spool = await db.get_spool(spool_id)
    if not spool:
        raise HTTPException(status_code=404, detail="Spool not found")

    # Check if tag is already assigned to another spool
    existing_spool = await db.get_spool_by_tag(request.tag_id)
    if existing_spool and existing_spool.id != spool_id:
        detail = f"Tag already assigned to spool: {existing_spool.brand or 'Unknown'} {existing_spool.material}"
        raise HTTPException(status_code=409, detail=detail)

    # Link the tag
    updated = await db.link_tag_to_spool(
        spool_id,
        request.tag_id,
        request.tag_type,
        request.data_origin or "nfc_link"
    )

    return updated


@router.post("/{spool_id}/weight", response_model=Spool)
async def set_spool_weight(spool_id: str, request: SetWeightRequest):
    """Set spool current weight from scale measurement.

    This updates the current weight and resets the consumed_since_weight counter.
    The weight should be the total weight including the spool core.

    Args:
        spool_id: Spool ID
        request: Weight data (total weight in grams)
    """
    db = await get_db()

    # Get spool to calculate net filament weight
    spool = await db.get_spool(spool_id)
    if not spool:
        raise HTTPException(status_code=404, detail="Spool not found")

    # Subtract core weight to get filament weight
    core_weight = spool.core_weight or 250
    filament_weight = max(0, request.weight - core_weight)

    updated = await db.set_spool_weight(spool_id, filament_weight)
    return updated


@router.post("/{spool_id}/usage", response_model=Spool)
async def log_manual_usage(spool_id: str, request: LogUsageRequest):
    """Manually log filament usage for a spool.

    Use this when usage wasn't automatically tracked (e.g., external printer,
    manual filament change, waste from failed print).

    Args:
        spool_id: Spool ID
        request: Usage data (weight consumed in grams)
    """
    db = await get_db()

    spool = await db.get_spool(spool_id)
    if not spool:
        raise HTTPException(status_code=404, detail="Spool not found")

    # Log to usage history
    await db.log_usage(
        spool_id=spool_id,
        printer_serial=request.printer_serial or "manual",
        print_name=request.print_name or "Manual entry",
        weight_used=request.weight_used,
    )

    # Update spool consumption
    updated = await db.update_spool_consumption(spool_id, request.weight_used)
    return updated


@router.get("/{spool_id}/history")
async def get_spool_usage_history(spool_id: str, limit: int = Query(default=50, le=500)):
    """Get usage history for a specific spool.

    Returns recent print jobs that used this spool with weight consumed.
    """
    db = await get_db()

    spool = await db.get_spool(spool_id)
    if not spool:
        raise HTTPException(status_code=404, detail="Spool not found")

    return await db.get_usage_history(spool_id=spool_id, limit=limit)


@router.get("/usage/history")
async def get_all_usage_history(limit: int = Query(default=100, le=500)):
    """Get global usage history across all spools.

    Returns recent print jobs with spool info and weight consumed.
    """
    db = await get_db()
    return await db.get_usage_history(limit=limit)


@router.get("/{spool_id}/k-profiles")
async def get_spool_k_profiles(spool_id: str):
    """Get K-profiles associated with a spool."""
    db = await get_db()

    spool = await db.get_spool(spool_id)
    if not spool:
        raise HTTPException(status_code=404, detail="Spool not found")

    return await db.get_spool_k_profiles(spool_id)


@router.put("/{spool_id}/k-profiles")
async def save_spool_k_profiles(spool_id: str, request: SaveKProfilesRequest):
    """Save K-profiles for a spool (replaces existing)."""
    db = await get_db()

    spool = await db.get_spool(spool_id)
    if not spool:
        raise HTTPException(status_code=404, detail="Spool not found")

    profiles = [p.model_dump() for p in request.profiles]
    await db.save_spool_k_profiles(spool_id, profiles)

    return {"status": "ok", "count": len(profiles)}
