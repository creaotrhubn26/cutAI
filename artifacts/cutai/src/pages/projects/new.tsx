import { useState } from "react";
import { useLocation } from "wouter";
import { useCreateProject } from "@workspace/api-client-react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Instagram, Youtube, MonitorPlay, Smartphone, Video, Briefcase, Plus, ArrowRight, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const formats = [
  { id: "instagram_reel", name: "Instagram Reel", icon: Instagram, ratio: "9:16", desc: "Fast-paced, high engagement" },
  { id: "tiktok", name: "TikTok", icon: Smartphone, ratio: "9:16", desc: "Trend-driven, punchy cuts" },
  { id: "youtube_short", name: "YouTube Short", icon: Youtube, ratio: "9:16", desc: "Quick loops, visual hooks" },
  { id: "youtube_long", name: "YouTube Video", icon: MonitorPlay, ratio: "16:9", desc: "Narrative driven, paced" },
  { id: "wedding_highlight", name: "Wedding Highlight", icon: Video, ratio: "16:9", desc: "Cinematic, emotional pacing" },
  { id: "ad_spot", name: "Commercial Spot", icon: Briefcase, ratio: "16:9", desc: "Tight runtime, high impact" },
];

const formSchema = z.object({
  name: z.string().min(1, "Project name is required"),
  description: z.string().optional(),
  targetFormat: z.enum(["instagram_reel", "tiktok", "youtube_short", "youtube_long", "wedding_highlight", "ad_spot", "custom"], {
    required_error: "Please select a target format.",
  }),
});

export default function NewProject() {
  const [, setLocation] = useLocation();
  const createProject = useCreateProject();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      description: "",
      targetFormat: undefined,
    },
  });

  const onSubmit = (values: z.infer<typeof formSchema>) => {
    createProject.mutate({ data: values }, {
      onSuccess: (data) => {
        setLocation(`/projects/${data.id}`);
      }
    });
  };

  return (
    <div className="max-w-4xl mx-auto p-8 pt-12">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Create New Project</h1>
        <p className="text-muted-foreground mt-2">
          Set up your workspace. The AI will tailor its editing decisions based on the target format.
        </p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
          <div className="grid gap-6 md:grid-cols-2">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem className="col-span-2 md:col-span-1">
                  <FormLabel>Project Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Summer Campaign 2024" {...field} className="h-12 bg-card" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem className="col-span-2 md:col-span-1">
                  <FormLabel>Description (Optional)</FormLabel>
                  <FormControl>
                    <Input placeholder="Brief notes about the project..." {...field} className="h-12 bg-card" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="targetFormat"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-lg">Target Format</FormLabel>
                <FormDescription>
                  This tells the AI how to analyze beats, silence, and optimal segment lengths.
                </FormDescription>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 pt-4">
                  {formats.map((format) => {
                    const isSelected = field.value === format.id;
                    const Icon = format.icon;
                    return (
                      <div
                        key={format.id}
                        className={cn(
                          "relative group flex flex-col items-center justify-center p-6 text-center rounded-xl border-2 cursor-pointer transition-all",
                          isSelected 
                            ? "border-primary bg-primary/5 shadow-md" 
                            : "border-border bg-card hover:border-primary/50 hover:bg-accent/50"
                        )}
                        onClick={() => field.onChange(format.id)}
                      >
                        <div className={cn(
                          "mb-3 p-3 rounded-full transition-colors",
                          isSelected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground group-hover:text-primary"
                        )}>
                          <Icon className="h-6 w-6" />
                        </div>
                        <h3 className="font-semibold text-sm mb-1">{format.name}</h3>
                        <p className="text-xs text-muted-foreground">{format.desc}</p>
                        <div className="absolute top-3 right-3 text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                          {format.ratio}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <FormMessage className="mt-2" />
              </FormItem>
            )}
          />

          <div className="flex justify-end pt-6 border-t border-border">
            <Button 
              type="button" 
              variant="ghost" 
              className="mr-4"
              onClick={() => setLocation('/projects')}
            >
              Cancel
            </Button>
            <Button 
              type="submit" 
              size="lg" 
              disabled={createProject.isPending}
              className="gap-2"
            >
              {createProject.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Create Project <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
