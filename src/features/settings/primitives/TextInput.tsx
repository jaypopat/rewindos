import { Input } from "@/components/ui/input";

export function TextInput({
  value,
  onChange,
  type = "text",
  list,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  list?: string;
  disabled?: boolean;
}) {
  return (
    <Input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="font-mono"
      list={list}
      disabled={disabled}
    />
  );
}
