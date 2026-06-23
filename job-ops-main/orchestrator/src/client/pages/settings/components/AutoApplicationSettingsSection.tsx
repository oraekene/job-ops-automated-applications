import { SettingsInput } from "@client/pages/settings/components/SettingsInput";
import { SettingsSectionFrame } from "@client/pages/settings/components/SettingsSectionFrame";
import type { AutoApplicationValues } from "@client/pages/settings/types";
import type { UpdateSettingsInput } from "@shared/settings-schema.js";
import type React from "react";
import { Controller, useFormContext } from "react-hook-form";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

type AutoApplicationSettingsSectionProps = {
  values: AutoApplicationValues;
  isLoading: boolean;
  isSaving: boolean;
  layoutMode?: "accordion" | "panel";
};

export const AutoApplicationSettingsSection: React.FC<
  AutoApplicationSettingsSectionProps
> = ({ values, isLoading, isSaving, layoutMode }) => {
  const {
    autoApplicationEnabled,
    autoApplicationDefaultCoverLetter,
    autoApplicationSalaryRequirement,
    autoApplicationPdfMaxAgeDays,
  } = values;
  const { control, watch } = useFormContext<UpdateSettingsInput>();

  const currentEnabled =
    watch("autoApplicationEnabled") ?? autoApplicationEnabled.default;

  return (
    <SettingsSectionFrame
      mode={layoutMode}
      title="Auto-Application Settings"
      value="auto-application"
    >
      <div className="space-y-4">
        {/* Enable auto-application toggle */}
        <div className="flex items-start space-x-3">
          <Controller
            name="autoApplicationEnabled"
            control={control}
            render={({ field }) => (
              <Checkbox
                id="autoApplicationEnabled"
                checked={field.value ?? autoApplicationEnabled.default}
                onCheckedChange={(checked) => {
                  field.onChange(
                    checked === "indeterminate" ? null : checked === true,
                  );
                }}
                disabled={isLoading || isSaving}
              />
            )}
          />
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="autoApplicationEnabled"
              className="text-sm font-medium leading-none cursor-pointer"
            >
              Enable Auto-Application
            </label>
            <p className="text-xs text-muted-foreground">
              Automatically apply to jobs that meet your scoring threshold.
              Requires a configured cover letter and salary requirement.
            </p>
          </div>
        </div>

        {currentEnabled && (
          <>
            <Separator />

            {/* Default cover letter */}
            <div className="space-y-3">
              <label
                htmlFor="autoApplicationDefaultCoverLetter"
                className="text-sm font-medium leading-none"
              >
                Default Cover Letter
              </label>
              <Controller
                name="autoApplicationDefaultCoverLetter"
                control={control}
                render={({ field }) => (
                  <div className="space-y-2">
                    <Textarea
                      id="autoApplicationDefaultCoverLetter"
                      value={
                        field.value ?? autoApplicationDefaultCoverLetter.default
                      }
                      onChange={(event) => field.onChange(event.target.value)}
                      placeholder="Dear Hiring Manager, I am writing to express my interest..."
                      disabled={isLoading || isSaving}
                      maxLength={10000}
                    />
                    <div className="text-xs text-muted-foreground">
                      Default cover letter template used when no job-specific
                      cover letter is provided.
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Current:{" "}
                      <span className="font-mono">
                        {autoApplicationDefaultCoverLetter.effective
                          ? `${autoApplicationDefaultCoverLetter.effective.slice(0, 80)}...`
                          : "—"}
                      </span>
                    </div>
                  </div>
                )}
              />
            </div>

            <Separator />

            {/* Salary requirement */}
            <Controller
              name="autoApplicationSalaryRequirement"
              control={control}
              render={({ field }) => (
                <SettingsInput
                  label="Salary Requirement"
                  inputProps={{
                    ...field,
                    value:
                      field.value ?? autoApplicationSalaryRequirement.default,
                    placeholder: "e.g. £40,000",
                  }}
                  disabled={isLoading || isSaving}
                  helper="Minimum annual salary to accept. Jobs below this will not be auto-applied."
                  current={`Effective: ${autoApplicationSalaryRequirement.effective || "—"} | Default: ${autoApplicationSalaryRequirement.default || "—"}`}
                />
              )}
            />

            <Separator />

            {/* PDF max age */}
            <Controller
              name="autoApplicationPdfMaxAgeDays"
              control={control}
              render={({ field }) => (
                <SettingsInput
                  label="PDF Max Age (Days)"
                  type="number"
                  inputProps={{
                    ...field,
                    inputMode: "numeric",
                    min: 1,
                    max: 365,
                    step: 1,
                    value: field.value ?? autoApplicationPdfMaxAgeDays.default,
                    onChange: (event) => {
                      const value = parseInt(event.target.value, 10);
                      if (Number.isNaN(value)) {
                        field.onChange(null);
                      } else {
                        field.onChange(Math.min(365, Math.max(1, value)));
                      }
                    },
                  }}
                  disabled={isLoading || isSaving}
                  helper="Maximum age in days for the auto-generated PDF resume. Older PDFs will be regenerated before applying."
                  current={`Effective: ${autoApplicationPdfMaxAgeDays.effective} | Default: ${autoApplicationPdfMaxAgeDays.default}`}
                />
              )}
            />
          </>
        )}
      </div>
    </SettingsSectionFrame>
  );
};
