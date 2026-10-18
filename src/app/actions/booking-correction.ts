"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser, userHasPermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { intakeBookingCorrection, type BookingCorrectionIntakeResult } from "@/server/booking-correction/intake";

export interface BookingActionState {
  error?: string;
  result?: BookingCorrectionIntakeResult;
}

export async function bookingCorrectionAction(
  _prev: BookingActionState,
  formData: FormData,
): Promise<BookingActionState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not authenticated." };
  if (!userHasPermission(user, PERMISSIONS.JOB_CREATE))
    return { error: "You do not have permission to create jobs." };

  const original = String(formData.get("original") ?? "").trim();
  const corrected = String(formData.get("corrected") ?? "").trim();
  if (!original || !corrected) return { error: "Both original and corrected booking details are required." };

  try {
    const result = await intakeBookingCorrection(original, corrected, { actor: user.email });
    revalidatePath("/modules/booking-correction");
    revalidatePath("/jobs");
    revalidatePath("/dashboard");
    return { result };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Booking correction failed." };
  }
}
